/**
 * Append-only history of what the site published: one JSON Lines file per service date
 * (`<dir>/<YYYY-MM-DD>.jsonl`, compressed to `.jsonl.gz` once the day is over).
 *
 * The site has no history of its own: a route page shows one day, and a stop time is
 * overwritten in place as the bus progresses. So the log records every *change* of a
 * published stop time, which is enough to reconstruct the day afterwards: the final value of a
 * `Live` stop is the actual passing time, the earlier values are the site's predictions.
 *
 * Record kinds (one JSON object per line, epoch seconds):
 * - `poll`: a route page was fetched: `{k, t, r, day, sd, trips, live, changed}`
 * - `trip`: a trip seen for the first time this service date (its schedule):
 *   `{k, t, r, d, trip, stops: [[stopId, schedS], ...]}` in travel order
 * - `obs`: a published time changed (or was first seen different from the schedule):
 *   `{k, t, r, d, trip, seq, stop, sched, time, live}` (`live` 1/0)
 *
 * Schedule-only stops whose published time equals the schedule carry no information and are
 * not logged until they change. On start the current day's files are replayed so a restart
 * logs only real changes.
 */
import { EventEmitter } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import {
  addDays,
  DAY_MS,
  localMidnight,
  resolveServiceDate,
  serviceDayStart,
  zonedParts,
  type PreparedTrip,
  type RawDirectionTimetable,
} from '@myciti/shared';

export interface PollRecord {
  k: 'poll';
  t: number;
  r: string;
  day: string;
  sd: string;
  trips: number;
  live: number;
  changed: number;
}

export interface TripRecord {
  k: 'trip';
  t: number;
  r: string;
  d: number;
  trip: string;
  stops: [string, number][];
}

export interface ObsRecord {
  k: 'obs';
  t: number;
  r: string;
  d: number;
  trip: string;
  seq: number;
  stop: string;
  sched: number;
  time: number;
  live: 0 | 1;
}

export type LogRecord = PollRecord | TripRecord | ObsRecord;

export interface ObservationLogOptions {
  dir: string;
  tz: string;
  /** delete day files older than this many days (0 = keep forever) */
  keepDays: number;
  now?: () => number;
}

export interface ObservationStatus {
  enabled: boolean;
  dir: string;
  /** service dates with an open (uncompressed) file */
  openDates: string[];
  recordsWritten: number;
  bytesWritten: number;
  lastWriteAt: number | null;
  lastError: string | null;
  files: number;
  bytesOnDisk: number;
}

const DATE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl(\.gz)?$/;

export function serviceDateOf(midnight: number, tz: string): string {
  const p = zonedParts(midnight + 12 * 3_600_000, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Service date (local calendar date) of a route page, as the engine resolves it. */
export function snapshotServiceDate(directions: RawDirectionTimetable[], fetchedAt: number, tz: string): string {
  const day = directions[0]?.day ?? '';
  const midnight = resolveServiceDate(day, fetchedAt, serviceDayStart(directions), tz);
  return serviceDateOf(midnight, tz);
}

const stopKey = (tripId: string, seq: number) => `${tripId}#${seq}`;
const stopValue = (sched: number, raw: number, live: boolean) => `${sched}|${raw}|${live ? 1 : 0}`;

interface RouteState {
  serviceDate: string;
  trips: Set<string>;
  stops: Map<string, string>;
}

/**
 * In-memory view of what has been logged for each route today, independent of the file I/O so
 * it can be tested and replayed. `diff()` returns the records a new snapshot adds.
 */
export class ObservationState {
  readonly routes = new Map<string, RouteState>();

  private routeState(routeId: string, serviceDate: string): RouteState {
    let st = this.routes.get(routeId);
    if (!st || st.serviceDate !== serviceDate) {
      st = { serviceDate, trips: new Set(), stops: new Map() };
      this.routes.set(routeId, st);
    }
    return st;
  }

  /** Records that a snapshot adds to the log; updates the state as if they were written. */
  diff(routeId: string, serviceDate: string, day: string, trips: PreparedTrip[], fetchedAt: number): LogRecord[] {
    const st = this.routeState(routeId, serviceDate);
    const t = Math.round(fetchedAt / 1000);
    const out: LogRecord[] = [];
    let live = 0;
    for (const trip of trips) {
      if (trip.live) live++;
      if (!st.trips.has(trip.tripId)) {
        st.trips.add(trip.tripId);
        out.push({
          k: 'trip',
          t,
          r: routeId,
          d: trip.directionId,
          trip: trip.tripId,
          stops: trip.stops.map((s) => [s.stopId, Math.round(s.sched / 1000)]),
        });
      }
      trip.stops.forEach((s, seq) => {
        const key = stopKey(trip.tripId, seq);
        const value = stopValue(Math.round(s.sched / 1000), Math.round(s.raw / 1000), s.live);
        const prev = st.stops.get(key);
        if (prev === value) return;
        // a schedule-only stop at its scheduled time says nothing until it changes
        const trivial = !s.live && s.raw === s.sched;
        if (prev === undefined && trivial) return;
        st.stops.set(key, value);
        out.push({
          k: 'obs',
          t,
          r: routeId,
          d: trip.directionId,
          trip: trip.tripId,
          seq,
          stop: s.stopId,
          sched: Math.round(s.sched / 1000),
          time: Math.round(s.raw / 1000),
          live: s.live ? 1 : 0,
        });
      });
    }
    const changed = out.filter((r) => r.k === 'obs').length;
    out.unshift({ k: 'poll', t, r: routeId, day, sd: serviceDate, trips: trips.length, live, changed });
    return out;
  }

  /** Feed a record read back from a file (startup replay). */
  replay(serviceDate: string, rec: LogRecord): void {
    if (rec.k === 'poll') return;
    const st = this.routeState(rec.r, serviceDate);
    if (rec.k === 'trip') st.trips.add(rec.trip);
    else st.stops.set(stopKey(rec.trip, rec.seq), stopValue(rec.sched, rec.time, rec.live === 1));
  }

  /** Forget routes that are no longer polled. */
  retain(routeIds: Iterable<string>): void {
    const keep = new Set(routeIds);
    for (const id of [...this.routes.keys()]) if (!keep.has(id)) this.routes.delete(id);
  }
}

/** Parse one line of a log file; null for blank or broken lines. */
export function parseLogLine(line: string): LogRecord | null {
  const s = line.trim();
  if (!s) return null;
  try {
    const r = JSON.parse(s) as LogRecord;
    return r && (r.k === 'poll' || r.k === 'trip' || r.k === 'obs') ? r : null;
  } catch {
    return null;
  }
}

/** Service date of a log file name, or null. */
export function logFileDate(name: string): string | null {
  return DATE_RE.exec(name)?.[1] ?? null;
}

/** Read every record of a day file (`.jsonl` or `.jsonl.gz`). */
export async function* readLogFile(file: string): AsyncGenerator<LogRecord> {
  const src = createReadStream(file);
  const stream = file.endsWith('.gz') ? src.pipe(createGunzip()) : src;
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const rec = parseLogLine(line);
    if (rec) yield rec;
  }
}

/** Every day file in a directory, oldest first, `.jsonl` before `.jsonl.gz`: `[serviceDate, path]`. */
export async function listAllLogFiles(dir: string): Promise<[string, string][]> {
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: [string, string][] = [];
  for (const n of names) {
    const d = logFileDate(n);
    if (d) out.push([d, join(dir, n)]);
  }
  return out.sort((a, b) => a[0].localeCompare(b[0]) || (a[1].endsWith('.gz') ? 1 : -1));
}

/**
 * One file per service date for readers, oldest first. Normally a date has either a `.jsonl`
 * or a `.jsonl.gz`; while compression is in progress both exist and the `.jsonl` is complete,
 * so it wins.
 */
export async function listLogFiles(dir: string): Promise<[string, string][]> {
  const seen = new Set<string>();
  return (await listAllLogFiles(dir)).filter(([d]) => (seen.has(d) ? false : (seen.add(d), true)));
}

export class ObservationLog extends EventEmitter {
  readonly state = new ObservationState();
  private readonly now: () => number;
  private writing = Promise.resolve();
  private recordsWritten = 0;
  private bytesWritten = 0;
  private lastWriteAt: number | null = null;
  private lastError: string | null = null;
  private lastWriteByDate = new Map<string, number>();
  private diskCache: { at: number; files: number; bytes: number } | null = null;
  private maintenanceTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: ObservationLogOptions) {
    super();
    this.now = opts.now ?? Date.now;
  }

  get dir(): string {
    return this.opts.dir;
  }

  /** Replay today's (and yesterday's) files so a restart does not re-log known values. */
  async init(): Promise<number> {
    await mkdir(this.opts.dir, { recursive: true });
    const today = localMidnight(this.now(), this.opts.tz);
    const recent = new Set([serviceDateOf(addDays(today, -1, this.opts.tz), this.opts.tz), serviceDateOf(today, this.opts.tz)]);
    let n = 0;
    for (const [date, file] of await listLogFiles(this.opts.dir)) {
      if (!recent.has(date) || file.endsWith('.gz')) continue;
      try {
        for await (const rec of readLogFile(file)) {
          this.state.replay(date, rec);
          n++;
        }
      } catch (e) {
        this.lastError = `replay ${file}: ${(e as Error).message}`;
      }
    }
    await this.maintain();
    return n;
  }

  /** Run compression and retention now and then every hour. */
  startMaintenance(intervalMs = 3_600_000): void {
    this.stopMaintenance();
    this.maintenanceTimer = setInterval(() => void this.maintain(), intervalMs);
    this.maintenanceTimer.unref();
  }

  stopMaintenance(): void {
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = null;
  }

  /** Log what a fresh route snapshot changed. Returns the records written. */
  record(routeId: string, directions: RawDirectionTimetable[], trips: PreparedTrip[], fetchedAt: number): LogRecord[] {
    const serviceDate = snapshotServiceDate(directions, fetchedAt, this.opts.tz);
    const records = this.state.diff(routeId, serviceDate, directions[0]?.day ?? '', trips, fetchedAt);
    const text = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
    this.lastWriteByDate.set(serviceDate, this.now());
    this.writing = this.writing
      .then(() => appendFile(join(this.opts.dir, `${serviceDate}.jsonl`), text))
      .then(() => {
        this.recordsWritten += records.length;
        this.bytesWritten += Buffer.byteLength(text);
        this.lastWriteAt = this.now();
        this.lastError = null;
        this.diskCache = null;
      })
      .catch((e: Error) => {
        this.lastError = `write ${serviceDate}: ${e.message}`;
        this.emit('error', e);
      });
    return records;
  }

  /** Wait for queued writes (tests, shutdown). */
  flush(): Promise<void> {
    return this.writing;
  }

  /**
   * Compress day files that can no longer be written to (service date at least two local
   * days ago, nothing written for an hour) and delete files beyond the retention window.
   */
  async maintain(): Promise<void> {
    const now = this.now();
    const today = localMidnight(now, this.opts.tz);
    const cutoff = serviceDateOf(addDays(today, -1, this.opts.tz), this.opts.tz);
    const keepFrom = this.opts.keepDays > 0 ? serviceDateOf(today - this.opts.keepDays * DAY_MS, this.opts.tz) : null;
    await this.flush();
    for (const [date, file] of await listAllLogFiles(this.opts.dir)) {
      try {
        if (keepFrom && date < keepFrom) {
          await unlink(file);
          continue;
        }
        if (file.endsWith('.gz') || date >= cutoff) continue;
        const last = this.lastWriteByDate.get(date);
        if (last !== undefined && now - last < 3_600_000) continue;
        await this.compress(file);
        this.lastWriteByDate.delete(date);
      } catch (e) {
        this.lastError = `maintenance ${file}: ${(e as Error).message}`;
      }
    }
    this.diskCache = null;
  }

  /**
   * `<date>.jsonl` -> `<date>.jsonl.gz`. If a compressed file already exists (a write landed
   * after compression) the new data is appended as another gzip member, which gunzip reads
   * as one stream.
   */
  private async compress(file: string): Promise<void> {
    const gz = `${file}.gz`;
    const tmp = `${gz}.tmp`;
    await pipeline(createReadStream(file), createGzip({ level: 6 }), createWriteStream(tmp));
    try {
      await stat(gz);
      await appendFile(gz, await readFile(tmp));
      await unlink(tmp);
    } catch {
      await rename(tmp, gz);
    }
    await unlink(file);
  }

  async status(): Promise<ObservationStatus> {
    const now = this.now();
    if (!this.diskCache || now - this.diskCache.at > 60_000) {
      let files = 0;
      let bytes = 0;
      for (const [, file] of await listLogFiles(this.opts.dir)) {
        try {
          bytes += (await stat(file)).size;
          files++;
        } catch {
          // being compressed or deleted
        }
      }
      this.diskCache = { at: now, files, bytes };
    }
    return {
      enabled: true,
      dir: this.opts.dir,
      openDates: [...this.lastWriteByDate.keys()].sort(),
      recordsWritten: this.recordsWritten,
      bytesWritten: this.bytesWritten,
      lastWriteAt: this.lastWriteAt,
      lastError: this.lastError,
      files: this.diskCache.files,
      bytesOnDisk: this.diskCache.bytes,
    };
  }
}

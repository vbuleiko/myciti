/**
 * Turn a service day of observation-log records back into stop times and punctuality
 * figures. Pure functions, used by `scripts/observations.ts` and the tests.
 */
import { zonedParts } from '@myciti/shared';
import type { LogRecord, ObsRecord } from './stores/observation-log';

export interface StopHistory {
  stopId: string;
  seq: number;
  /** scheduled time, epoch s */
  sched: number;
  /** every published value in the order it was seen */
  history: { t: number; time: number; live: boolean }[];
}

export interface TripHistory {
  routeId: string;
  directionId: number;
  tripId: string;
  /** first time the trip was seen in the log */
  firstSeenAt: number;
  stops: StopHistory[];
}

export interface DayHistory {
  serviceDate: string;
  /** key `${routeId}:${tripId}` */
  trips: Map<string, TripHistory>;
  polls: number;
  /** routes with at least one poll record */
  routes: Set<string>;
}

/** Groups a day's records by trip and stop, one record at a time (files are streamed). */
export class DayBuilder {
  private readonly day: DayHistory;
  private readonly pending = new Map<string, ObsRecord[]>();

  constructor(serviceDate: string) {
    this.day = { serviceDate, trips: new Map(), polls: 0, routes: new Set() };
  }

  add(rec: LogRecord): void {
    const day = this.day;
    if (rec.k === 'poll') {
      day.polls++;
      day.routes.add(rec.r);
      return;
    }
    const key = `${rec.r}:${rec.trip}`;
    if (rec.k === 'trip') {
      // trip records restate the schedule (after a restart); the last one wins
      const existing = day.trips.get(key);
      const stops: StopHistory[] = rec.stops.map(([stopId, sched], seq) => ({
        stopId,
        seq,
        sched,
        history: existing?.stops[seq]?.stopId === stopId ? existing.stops[seq]!.history : [],
      }));
      const trip: TripHistory = { routeId: rec.r, directionId: rec.d, tripId: rec.trip, firstSeenAt: existing?.firstSeenAt ?? rec.t, stops };
      day.trips.set(key, trip);
      const late = this.pending.get(key);
      if (late) {
        for (const o of late) attach(trip, o);
        this.pending.delete(key);
      }
      return;
    }
    const trip = day.trips.get(key);
    if (trip) attach(trip, rec);
    else {
      // observation before its trip record (file truncated / started mid-day): keep for later
      const list = this.pending.get(key) ?? [];
      list.push(rec);
      this.pending.set(key, list);
    }
  }

  finish(): DayHistory {
    // observations whose trip record never came: rebuild the trip from them
    for (const [key, obs] of this.pending) {
      const first = obs[0]!;
      const n = Math.max(...obs.map((o) => o.seq)) + 1;
      const stops: StopHistory[] = Array.from({ length: n }, (_, seq) => ({ stopId: '', seq, sched: NaN, history: [] }));
      const trip: TripHistory = { routeId: first.r, directionId: first.d, tripId: first.trip, firstSeenAt: first.t, stops };
      for (const o of obs) {
        stops[o.seq]!.stopId = o.stop;
        stops[o.seq]!.sched = o.sched;
        attach(trip, o);
      }
      this.day.trips.set(key, trip);
    }
    this.pending.clear();
    return this.day;
  }
}

/** Turn a day's records back into trips with their stop-time history. */
export function reconstructDay(serviceDate: string, records: Iterable<LogRecord>): DayHistory {
  const b = new DayBuilder(serviceDate);
  for (const rec of records) b.add(rec);
  return b.finish();
}

export async function reconstructDayAsync(serviceDate: string, records: AsyncIterable<LogRecord>): Promise<DayHistory> {
  const b = new DayBuilder(serviceDate);
  for await (const rec of records) b.add(rec);
  return b.finish();
}

function attach(trip: TripHistory, o: ObsRecord): void {
  const s = trip.stops[o.seq];
  if (!s) return;
  if (!s.stopId) s.stopId = o.stop;
  if (Number.isNaN(s.sched)) s.sched = o.sched;
  s.history.push({ t: o.t, time: o.time, live: o.live === 1 });
}

export interface StopTimeRow {
  serviceDate: string;
  routeId: string;
  directionId: number;
  tripId: string;
  seq: number;
  stopId: string;
  /** epoch s */
  sched: number;
  /** final published time if the stop ended up `Live`, else null; epoch s */
  actual: number | null;
  /** actual - sched, minutes (null without actual) */
  delayMin: number | null;
  /** when the stop was first published as `Live`, epoch s */
  firstLiveAt: number | null;
  /** when the final value was published, epoch s */
  lastChangeAt: number | null;
  /** number of published values seen for this stop */
  revisions: number;
  /** the trip had live data at some stop */
  tracked: boolean;
}

/** One row per trip and stop, in travel order. */
export function stopTimeRows(day: DayHistory): StopTimeRow[] {
  const rows: StopTimeRow[] = [];
  const trips = [...day.trips.values()].sort(
    (a, b) => a.routeId.localeCompare(b.routeId) || (a.stops[0]?.sched ?? 0) - (b.stops[0]?.sched ?? 0) || a.tripId.localeCompare(b.tripId),
  );
  for (const trip of trips) {
    const tracked = trip.stops.some((s) => s.history.some((h) => h.live));
    for (const s of trip.stops) {
      const last = s.history[s.history.length - 1];
      const actual = last && last.live ? last.time : null;
      rows.push({
        serviceDate: day.serviceDate,
        routeId: trip.routeId,
        directionId: trip.directionId,
        tripId: trip.tripId,
        seq: s.seq,
        stopId: s.stopId,
        sched: s.sched,
        actual,
        delayMin: actual === null ? null : Math.round(((actual - s.sched) / 60) * 10) / 10,
        firstLiveAt: s.history.find((h) => h.live)?.t ?? null,
        lastChangeAt: last?.t ?? null,
        revisions: s.history.length,
        tracked,
      });
    }
  }
  return rows;
}

export interface PunctualityRow {
  routeId: string;
  directionId: number;
  /** local hour of the scheduled departure, 0-23 (or -1 for the whole day) */
  hour: number;
  tripsScheduled: number;
  tripsTracked: number;
  /** trips whose first and last stop both have actual times */
  tripsComplete: number;
  /** minutes, over tracked trips with an actual at that stop */
  departureDelayMedian: number | null;
  arrivalDelayMedian: number | null;
  arrivalDelayP85: number | null;
  /** share of complete trips arriving within [-1, +5] min */
  onTimeShare: number | null;
  /** median of actual / scheduled end-to-end running time */
  runTimeRatioMedian: number | null;
}

const quantile = (xs: number[], q: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
};
const round1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);

/**
 * Punctuality per route, direction and hour of scheduled departure, over any number of days'
 * rows. `hour = -1` rows aggregate the whole day.
 */
export function punctualityRows(rows: StopTimeRow[], tz: string): PunctualityRow[] {
  interface Acc {
    scheduled: number;
    tracked: number;
    complete: number;
    dep: number[];
    arr: number[];
    onTime: number;
    ratio: number[];
  }
  const groups = new Map<string, Acc>();
  const acc = (key: string): Acc => {
    let a = groups.get(key);
    if (!a) {
      a = { scheduled: 0, tracked: 0, complete: 0, dep: [], arr: [], onTime: 0, ratio: [] };
      groups.set(key, a);
    }
    return a;
  };
  // rows -> trips
  const byTrip = new Map<string, StopTimeRow[]>();
  for (const r of rows) {
    const k = `${r.serviceDate}|${r.routeId}|${r.tripId}`;
    const l = byTrip.get(k) ?? [];
    l.push(r);
    byTrip.set(k, l);
  }
  for (const stops of byTrip.values()) {
    stops.sort((a, b) => a.seq - b.seq);
    const first = stops[0]!;
    const last = stops[stops.length - 1]!;
    if (!Number.isFinite(first.sched)) continue;
    const hour = zonedParts(first.sched * 1000, tz).hour;
    for (const h of [hour, -1]) {
      const a = acc(`${first.routeId}|${first.directionId}|${h}`);
      a.scheduled++;
      if (!first.tracked) continue;
      a.tracked++;
      if (first.delayMin !== null) a.dep.push(first.delayMin);
      if (last.delayMin !== null) a.arr.push(last.delayMin);
      if (first.actual !== null && last.actual !== null && last !== first) {
        a.complete++;
        if (last.delayMin! >= -1 && last.delayMin! <= 5) a.onTime++;
        const schedRun = last.sched - first.sched;
        if (schedRun > 0) a.ratio.push((last.actual - first.actual) / schedRun);
      }
    }
  }
  const out: PunctualityRow[] = [];
  for (const [key, a] of groups) {
    const [routeId, d, h] = key.split('|');
    out.push({
      routeId: routeId!,
      directionId: Number(d),
      hour: Number(h),
      tripsScheduled: a.scheduled,
      tripsTracked: a.tracked,
      tripsComplete: a.complete,
      departureDelayMedian: round1(quantile(a.dep, 0.5)),
      arrivalDelayMedian: round1(quantile(a.arr, 0.5)),
      arrivalDelayP85: round1(quantile(a.arr, 0.85)),
      onTimeShare: a.complete ? Math.round((a.onTime / a.complete) * 1000) / 1000 : null,
      runTimeRatioMedian: a.ratio.length ? Math.round(quantile(a.ratio, 0.5)! * 1000) / 1000 : null,
    });
  }
  return out.sort((x, y) => x.routeId.localeCompare(y.routeId) || x.directionId - y.directionId || x.hour - y.hour);
}

/** RFC 4180-ish CSV line. */
export function csvLine(values: (string | number | boolean | null | undefined)[]): string {
  return values
    .map((v) => {
      if (v === null || v === undefined) return '';
      const s = typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(',');
}

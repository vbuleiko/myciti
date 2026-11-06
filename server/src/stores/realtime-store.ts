import { EventEmitter } from 'node:events';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  prepareRouteTrips,
  type EngineOptions,
  type NetworkIndex,
  type PreparedTrip,
  type RawDirectionTimetable,
} from '@myciti/shared';

export interface RouteSnapshot {
  routeId: string;
  fetchedAt: number;
  day: string;
  serviceAdvisory: string | null;
  /** all trips of the day (live and schedule-only) */
  trips: PreparedTrip[];
  warnings: string[];
}

export interface TripWindow {
  /** include trips that ended up to this long ago */
  pastMs: number;
  /** include trips that start within this */
  futureMs: number;
}

export const DEFAULT_WINDOW: TripWindow = { pastMs: 5 * 60_000, futureMs: 30 * 60_000 };

/** Live trips that matter around `now` (buses that can be on the map soon). */
export function tripsInWindow(trips: Iterable<PreparedTrip>, now: number, w: TripWindow = DEFAULT_WINDOW): PreparedTrip[] {
  const out: PreparedTrip[] = [];
  for (const t of trips) {
    if (!t.live || t.stops.length === 0) continue;
    const first = t.stops[0]!.fit;
    const last = t.stops[t.stops.length - 1]!.fit;
    if (last >= now - w.pastMs && first <= now + w.futureMs) out.push(t);
  }
  return out;
}

/** Latest timetable snapshot per route, prepared for positioning. */
export class RealtimeStore extends EventEmitter {
  private snapshots = new Map<string, RouteSnapshot>();
  private raw = new Map<string, { fetchedAt: number; directions: RawDirectionTimetable[]; warnings: string[] }>();
  private matchCache = new Map<string, number[]>();

  constructor(
    private getIndex: () => NetworkIndex | null,
    private readonly tz: string,
    private readonly engine: Partial<EngineOptions>,
    /** directory for the last raw snapshot of each route (survives restarts); null = memory only */
    private readonly dir: string | null = null,
  ) {
    super();
  }

  update(routeId: string, directions: RawDirectionTimetable[], fetchedAt: number, warnings: string[] = []): RouteSnapshot | null {
    this.raw.set(routeId, { fetchedAt, directions, warnings });
    const snap = this.prepare(routeId);
    if (snap) this.emit('route', snap);
    void this.persist(routeId);
    return snap;
  }

  private async persist(routeId: string): Promise<void> {
    if (!this.dir) return;
    try {
      await mkdir(this.dir, { recursive: true });
      const file = join(this.dir, `${encodeURIComponent(routeId)}.json`);
      await writeFile(`${file}.tmp`, JSON.stringify({ routeId, ...this.raw.get(routeId) }));
      await rename(`${file}.tmp`, file);
    } catch {
      // cache only
    }
  }

  /** Load snapshots saved by a previous run that are younger than maxAgeMs. */
  async loadSaved(maxAgeMs: number): Promise<number> {
    if (!this.dir) return 0;
    let n = 0;
    let files: string[] = [];
    try {
      files = (await readdir(this.dir)).filter((f) => f.endsWith('.json'));
    } catch {
      return 0;
    }
    for (const f of files) {
      try {
        const d = JSON.parse(await readFile(join(this.dir, f), 'utf8')) as {
          routeId: string;
          fetchedAt: number;
          directions: RawDirectionTimetable[];
          warnings?: string[];
        };
        if (!d.routeId || !Array.isArray(d.directions) || Date.now() - d.fetchedAt > maxAgeMs) continue;
        this.raw.set(d.routeId, { fetchedAt: d.fetchedAt, directions: d.directions, warnings: d.warnings ?? [] });
        if (this.prepare(d.routeId)) n++;
      } catch {
        // ignore broken cache files
      }
    }
    return n;
  }

  private prepare(routeId: string): RouteSnapshot | null {
    const r = this.raw.get(routeId);
    const idx = this.getIndex();
    if (!r || !idx) return null;
    const trips = prepareRouteTrips(r.directions, {
      idx,
      fetchedAt: r.fetchedAt,
      tz: this.tz,
      options: this.engine,
      matchCache: this.matchCache,
    });
    const snap: RouteSnapshot = {
      routeId,
      fetchedAt: r.fetchedAt,
      day: r.directions[0]?.day ?? '',
      serviceAdvisory: r.directions.find((d) => d.serviceAdvisory)?.serviceAdvisory ?? null,
      trips,
      warnings: r.warnings,
    };
    this.snapshots.set(routeId, snap);
    return snap;
  }

  /** Re-run preparation after the network (shapes, sequences) changed. */
  reprepareAll(): void {
    this.matchCache.clear();
    for (const routeId of this.raw.keys()) {
      const snap = this.prepare(routeId);
      if (snap) this.emit('route', snap);
    }
  }

  get(routeId: string): RouteSnapshot | undefined {
    return this.snapshots.get(routeId);
  }

  all(): RouteSnapshot[] {
    return [...this.snapshots.values()];
  }

  *allTrips(): Iterable<PreparedTrip> {
    for (const s of this.snapshots.values()) yield* s.trips;
  }
}

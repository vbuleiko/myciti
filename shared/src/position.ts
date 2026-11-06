import { DEFAULT_ENGINE_OPTIONS, type EngineOptions, type PreparedTrip, type VehicleEstimate } from './types';

/**
 * Estimated position of a live trip at `now` (epoch ms), interpolated along the route
 * between the two stops whose (fitted) times bracket `now`. Returns null when the bus should
 * not be shown (not live, too early, or finished).
 */
export function estimateVehicle(
  trip: PreparedTrip,
  now: number,
  options: Partial<EngineOptions> = {},
): VehicleEstimate | null {
  if (!trip.live) return null;
  const opts = { ...DEFAULT_ENGINE_OPTIONS, ...options };
  // a forecast from a snapshot that is too old is not worth drawing
  if (opts.maxDataAgeMs > 0 && now - trip.fetchedAt > opts.maxDataAgeMs) return null;
  const s = trip.stops;
  const n = s.length;
  if (n === 0) return null;
  const first = s[0]!;
  const last = s[n - 1]!;

  if (now < first.fit) {
    if (first.fit - now > opts.preDepartureMs) return null;
    return { key: trip.key, state: 'waiting', dist: first.dist, prevIdx: 0, nextIdx: 0, delaySec: (first.fit - first.sched) / 1000 };
  }
  if (now >= last.fit) {
    if (now - last.fit > opts.postArrivalMs) return null;
    return {
      key: trip.key,
      state: 'arrived',
      dist: last.dist,
      prevIdx: n - 1,
      nextIdx: n - 1,
      delaySec: (last.fit - last.sched) / 1000,
    };
  }
  // binary search: largest i with fit[i] <= now (now < last.fit so i < n - 1)
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid]!.fit <= now) lo = mid;
    else hi = mid;
  }
  const a = s[lo]!;
  const b = s[lo + 1]!;
  const span = b.fit - a.fit;
  const f = span > 0 ? (now - a.fit) / span : 1;
  const dist = a.dist + f * (b.dist - a.dist);
  const da = a.fit - a.sched;
  const db = b.fit - b.sched;
  return {
    key: trip.key,
    state: 'moving',
    dist,
    prevIdx: lo,
    nextIdx: lo + 1,
    delaySec: (da + f * (db - da)) / 1000,
  };
}

export interface EstimatedVehicle {
  trip: PreparedTrip;
  est: VehicleEstimate;
  /** trip key of a trip merged into this marker (same bus at a terminal) */
  mergedFrom?: string;
}

/**
 * Estimate all trips and merge duplicates at terminals: one bus is often both at the end of
 * one trip and at the start of the next one. If trip A has finished (or is about to) at a stop
 * and a trip B of the same route starts from the same stop (or one within
 * `terminalMergeMaxDistM`) within `terminalMergeMaxGapMs`, only B is shown.
 *
 * `stopDistance(a, b)` returns metres between two stop ids.
 */
export function estimateAll(
  trips: Iterable<PreparedTrip>,
  now: number,
  stopDistance: (a: string, b: string) => number,
  options: Partial<EngineOptions> = {},
): EstimatedVehicle[] {
  const opts = { ...DEFAULT_ENGINE_OPTIONS, ...options };
  const out: EstimatedVehicle[] = [];
  for (const trip of trips) {
    const est = estimateVehicle(trip, now, opts);
    if (est) out.push({ trip, est });
  }
  return dedupeTerminals(out, now, stopDistance, opts);
}

export function dedupeTerminals(
  vehicles: EstimatedVehicle[],
  now: number,
  stopDistance: (a: string, b: string) => number,
  options: Partial<EngineOptions> = {},
): EstimatedVehicle[] {
  const opts = { ...DEFAULT_ENGINE_OPTIONS, ...options };
  // A: trips that have arrived at their last stop
  const ended = vehicles.filter((v) => v.est.state === 'arrived');
  // B: trips waiting at / just departed from their first stop
  const starting = vehicles.filter(
    (v) => v.est.state === 'waiting' || (v.est.state === 'moving' && now - v.trip.stops[0]!.fit <= 2 * 60_000),
  );
  if (ended.length === 0 || starting.length === 0) return vehicles;

  type Pair = { a: EstimatedVehicle; b: EstimatedVehicle; gap: number };
  const pairs: Pair[] = [];
  for (const a of ended) {
    const aLast = a.trip.stops[a.trip.stops.length - 1]!;
    for (const b of starting) {
      if (a === b || a.trip.routeId !== b.trip.routeId) continue;
      const bFirst = b.trip.stops[0]!;
      const gap = bFirst.fit - aLast.fit;
      if (gap < -3 * 60_000 || gap > opts.terminalMergeMaxGapMs) continue;
      if (stopDistance(aLast.stopId, bFirst.stopId) > opts.terminalMergeMaxDistM) continue;
      pairs.push({ a, b, gap: Math.abs(gap) });
    }
  }
  pairs.sort((x, y) => x.gap - y.gap);
  const removed = new Set<EstimatedVehicle>();
  const usedB = new Set<EstimatedVehicle>();
  for (const p of pairs) {
    if (removed.has(p.a) || usedB.has(p.b)) continue;
    removed.add(p.a);
    usedB.add(p.b);
    p.b.mergedFrom = p.a.trip.key;
  }
  return vehicles.filter((v) => !removed.has(v));
}

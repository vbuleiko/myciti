import { buildShape, distanceM, type Shape } from './geo';
import { robustMonotoneFit, spreadEqualTimes } from './robust-fit';
import { matchStopsToShape } from './shape-match';
import {
  circularStart,
  DEFAULT_TZ,
  MIN_MS,
  parseClock,
  resolveServiceDate,
  unwrapFrom,
  wrapMinutes,
} from './time';
import {
  DEFAULT_ENGINE_OPTIONS,
  type EngineOptions,
  type LngLat,
  type NetworkDirection,
  type NetworkRoute,
  type NetworkStop,
  type PreparedTrip,
  type RawDirectionTimetable,
  type RawStopTime,
  type RawTrip,
  type TripStop,
} from './types';

/** Lookup helpers built once per network. */
export interface NetworkIndex {
  routes: Map<string, NetworkRoute>;
  stops: Map<string, NetworkStop>;
  /** key `${routeId}:${directionId}` */
  shapes: Map<string, Shape>;
  directions: Map<string, NetworkDirection>;
}

export function indexNetwork(routes: NetworkRoute[], stops: NetworkStop[]): NetworkIndex {
  const idx: NetworkIndex = { routes: new Map(), stops: new Map(), shapes: new Map(), directions: new Map() };
  for (const s of stops) idx.stops.set(s.id, s);
  for (const r of routes) {
    idx.routes.set(r.id, r);
    for (const d of r.directions) {
      const key = `${r.id}:${d.directionId}`;
      idx.directions.set(key, d);
      idx.shapes.set(key, buildShape(d.shape));
    }
  }
  return idx;
}

export function directionKey(routeId: string, directionId: number): string {
  return `${routeId}:${directionId}`;
}

/**
 * Shape used for a trip: the direction's published trace, or straight lines between the
 * trip's stops if the network has no trace for it.
 */
export function shapeForTrip(idx: NetworkIndex, routeId: string, directionId: number, stopIds: string[]): Shape {
  const s = idx.shapes.get(directionKey(routeId, directionId));
  if (s && s.coords.length >= 2) return s;
  const coords: LngLat[] = [];
  for (const id of stopIds) {
    const st = idx.stops.get(id);
    if (st) coords.push([st.lng, st.lat]);
  }
  return buildShape(coords);
}

interface OrderedStop {
  raw: RawStopTime;
  /** minutes after the trip's start clock (static) */
  schedOff: number;
  /** published time, minutes after the trip's start clock */
  rawOff: number;
}

/**
 * The site lists a trip's stops sorted by the *live* time. Restore the travel order:
 * sort by scheduled time (unwrapped around midnight), breaking ties with the direction's
 * published stop sequence.
 */
export function orderTripStops(stops: RawStopTime[], sequence: string[] | undefined): { startClock: number; ordered: OrderedStop[] } {
  const parsed = stops
    .map((s, i) => ({ s, i, st: parseClock(s.staticTime), t: parseClock(s.time) }))
    .filter((x) => x.st !== null);
  const startClock = circularStart(parsed.map((x) => x.st!));
  const items = parsed.map((x) => {
    const schedOff = unwrapFrom(x.st!, startClock) - startClock;
    const t = x.t ?? x.st!;
    const rawOff = schedOff + wrapMinutes(t - x.st!);
    return { raw: x.s, i: x.i, schedOff, rawOff };
  });
  items.sort((a, b) => a.schedOff - b.schedOff || a.i - b.i);

  // tie groups (same scheduled minute): order by position in the published sequence
  if (sequence && sequence.length) {
    let cursor = 0;
    let g = 0;
    while (g < items.length) {
      let h = g;
      while (h + 1 < items.length && items[h + 1]!.schedOff === items[g]!.schedOff) h++;
      if (h > g) {
        const group = items.slice(g, h + 1).map((it) => {
          let pos = sequence.indexOf(it.raw.stopId, cursor);
          if (pos < 0) pos = sequence.indexOf(it.raw.stopId);
          return { it, pos: pos < 0 ? Number.MAX_SAFE_INTEGER : pos };
        });
        group.sort((a, b) => a.pos - b.pos || a.it.i - b.it.i);
        group.forEach((x, k) => (items[g + k] = x.it));
        const finite = group.filter((x) => x.pos !== Number.MAX_SAFE_INTEGER).map((x) => x.pos);
        if (finite.length) cursor = Math.max(cursor, ...finite);
      } else {
        const pos = sequence.indexOf(items[g]!.raw.stopId, cursor);
        if (pos >= 0) cursor = pos;
      }
      g = h + 1;
    }
  }
  return { startClock, ordered: items.map(({ raw, schedOff, rawOff }) => ({ raw, schedOff, rawOff })) };
}

export interface PrepareContext {
  idx: NetworkIndex;
  fetchedAt: number;
  tz?: string;
  options?: Partial<EngineOptions>;
  /** cache of stop-to-shape matches keyed by direction + stop pattern */
  matchCache?: Map<string, number[]>;
}

/** Earliest trip start (clock minutes) of a route's service day: the minute after the night gap. */
export function serviceDayStart(timetables: RawDirectionTimetable[]): number {
  const starts: number[] = [];
  for (const d of timetables) {
    for (const t of d.trips) {
      const mins = t.stops.map((s) => parseClock(s.staticTime)).filter((m): m is number => m !== null);
      if (mins.length) starts.push(circularStart(mins));
    }
  }
  return circularStart(starts);
}

/** Turn the raw timetable of one route into prepared trips (all trips, live or not). */
export function prepareRouteTrips(timetables: RawDirectionTimetable[], ctx: PrepareContext): PreparedTrip[] {
  const tz = ctx.tz ?? DEFAULT_TZ;
  const opts = { ...DEFAULT_ENGINE_OPTIONS, ...ctx.options };
  const dayStart = serviceDayStart(timetables);
  const out: PreparedTrip[] = [];
  for (const dt of timetables) {
    const serviceMidnight = resolveServiceDate(dt.day, ctx.fetchedAt, dayStart, tz);
    for (const trip of dt.trips) {
      const p = prepareTrip(dt, trip, serviceMidnight, dayStart, ctx, opts);
      if (p) out.push(p);
    }
  }
  return out;
}

export function prepareTrip(
  dt: RawDirectionTimetable,
  trip: RawTrip,
  serviceMidnight: number,
  dayStart: number,
  ctx: PrepareContext,
  opts: EngineOptions,
): PreparedTrip | null {
  const { idx } = ctx;
  const dirKey = directionKey(dt.routeId, dt.directionId);
  const direction = idx.directions.get(dirKey);
  const { startClock, ordered } = orderTripStops(trip.stops, direction?.stopIds);
  if (ordered.length === 0) return null;

  const tripStart = serviceMidnight + unwrapFrom(startClock, dayStart) * MIN_MS;
  const sched = ordered.map((o) => tripStart + o.schedOff * MIN_MS);
  const raw = ordered.map((o) => tripStart + o.rawOff * MIN_MS);
  const live = ordered.map((o) => o.raw.live);
  const anyLive = live.some(Boolean);

  // 1. robust monotone fit (prefer live observations)
  const { fit: fitted, outlier } = robustMonotoneFit({
    sched,
    raw,
    weight: live.map((l) => (l || !anyLive ? 1 : 0.5)),
  });

  // 2. distances along the shape
  const stopIds = ordered.map((o) => o.raw.stopId);
  const shape = shapeForTrip(idx, dt.routeId, dt.directionId, stopIds);
  const cacheKey = `${dirKey}|${stopIds.join(',')}`;
  let dist = ctx.matchCache?.get(cacheKey);
  if (!dist) {
    const pts: LngLat[] = [];
    const known: boolean[] = [];
    for (const id of stopIds) {
      const st = idx.stops.get(id);
      known.push(!!st);
      pts.push(st ? [st.lng, st.lat] : [NaN, NaN]);
    }
    dist = matchKnownStops(shape, pts, known);
    ctx.matchCache?.set(cacheKey, dist);
  }

  // 3. spread equal (minute-precision) times at uniform speed
  const fit = spreadEqualTimes(fitted, dist, MIN_MS);

  const stops: TripStop[] = ordered.map((o, k) => ({
    stopId: o.raw.stopId,
    name: o.raw.name,
    sched: sched[k]!,
    raw: raw[k]!,
    fit: fit[k]!,
    live: live[k]!,
    outlier: outlier[k]!,
    dist: dist![k]!,
  }));

  let maxAbs = 0;
  for (let k = 0; k < stops.length; k++) {
    if (!live[k]) continue;
    maxAbs = Math.max(maxAbs, Math.abs(fitted[k]! - sched[k]!));
  }

  const headsign = direction?.headsign ?? dt.routeName;
  return {
    key: `${dt.routeId}:${trip.tripId}`,
    routeId: dt.routeId,
    directionId: dt.directionId,
    tripId: trip.tripId,
    headsign,
    fetchedAt: ctx.fetchedAt,
    live: anyLive,
    suspect: anyLive && maxAbs > opts.suspectThresholdMs,
    maxAbsDelayMin: Math.round(maxAbs / MIN_MS),
    stops,
  };
}

/** Match stops with known coordinates; unknown ones get interpolated distances. */
function matchKnownStops(shape: Shape, pts: LngLat[], known: boolean[]): number[] {
  const knownPts = pts.filter((_, i) => known[i]);
  const m = matchStopsToShape(shape, knownPts);
  const out = new Array<number>(pts.length).fill(NaN);
  let j = 0;
  for (let i = 0; i < pts.length; i++) if (known[i]) out[i] = m[j++]!.dist;
  // fill unknowns from neighbours
  for (let i = 0; i < out.length; i++) {
    if (!Number.isNaN(out[i]!)) continue;
    let a = i - 1;
    while (a >= 0 && Number.isNaN(out[a]!)) a--;
    let b = i + 1;
    while (b < out.length && Number.isNaN(out[b]!)) b++;
    const da = a >= 0 ? out[a]! : 0;
    const db = b < out.length ? out[b]! : a >= 0 ? out[a]! : shape.length;
    out[i] = da + ((db - da) * (i - a)) / (b - a);
  }
  return out;
}

/** Distance in metres between two stops of the network (Infinity if unknown). */
export function stopDistanceM(idx: NetworkIndex, a: string, b: string): number {
  if (a === b) return 0;
  const sa = idx.stops.get(a);
  const sb = idx.stops.get(b);
  if (!sa || !sb) return Infinity;
  return distanceM([sa.lng, sa.lat], [sb.lng, sb.lat]);
}

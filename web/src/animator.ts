import {
  bearingAt,
  estimateAll,
  pointAt,
  shapeForTrip,
  stopDistanceM,
  type EngineOptions,
  type EstimatedVehicle,
  type NetworkIndex,
  type PreparedTrip,
  type Shape,
} from '@myciti/shared';

export interface AnimatedVehicle extends EstimatedVehicle {
  /** displayed distance along the shape (smoothed) */
  shownDist: number;
  lng: number;
  lat: number;
  bearing: number;
}

interface Track {
  target: number;
  offset: number;
  shown: number;
  t: number;
  fetchedAt: number;
}

/** Time constant for easing out a jump caused by new data, ms. */
const EASE_MS = 1500;
/** Faster than any bus: a target that moves more than this between frames is a data jump. */
const MAX_SPEED_M_PER_MS = 0.04; // 144 km/h
const SNAP_DIST_M = 3000;

/**
 * Computes vehicle positions for every animation frame. Between data updates the target
 * position moves continuously along the route (interpolated stop times). When fresh data moves
 * the target (bus is earlier/later than predicted), the marker glides to the new position along
 * the route instead of teleporting: the jump becomes an offset that decays exponentially.
 */
export class VehicleAnimator {
  private tracks = new Map<string, Track>();
  private shapeCache = new WeakMap<PreparedTrip, Shape>();

  constructor(private idx: NetworkIndex) {}

  setIndex(idx: NetworkIndex): void {
    if (idx !== this.idx) {
      this.idx = idx;
      this.shapeCache = new WeakMap();
    }
  }

  private shape(trip: PreparedTrip): Shape {
    let s = this.shapeCache.get(trip);
    if (!s) {
      s = shapeForTrip(this.idx, trip.routeId, trip.directionId, trip.stops.map((x) => x.stopId));
      this.shapeCache.set(trip, s);
    }
    return s;
  }

  frame(trips: Iterable<PreparedTrip>, now: number, engine: EngineOptions): AnimatedVehicle[] {
    const vehicles = estimateAll(trips, now, (a, b) => stopDistanceM(this.idx, a, b), engine);
    const seen = new Set<string>();
    const out: AnimatedVehicle[] = [];
    for (const v of vehicles) {
      const key = v.trip.key;
      seen.add(key);
      const shape = this.shape(v.trip);
      const target = v.est.dist;
      const prev = this.tracks.get(key);
      let offset = 0;
      if (prev) {
        const dt = Math.max(1, now - prev.t);
        offset = prev.offset * Math.exp(-dt / EASE_MS);
        const moved = target - prev.target;
        const dataChanged = prev.fetchedAt !== v.trip.fetchedAt;
        if (dataChanged || Math.abs(moved) > MAX_SPEED_M_PER_MS * dt + 5) {
          // keep the marker where it was on screen and ease towards the new target
          offset = prev.shown - target;
        }
        if (Math.abs(offset) > SNAP_DIST_M || Math.abs(offset) < 0.05) offset = 0;
      }
      const shown = Math.min(Math.max(target + offset, 0), shape.length);
      this.tracks.set(key, { target, offset, shown, t: now, fetchedAt: v.trip.fetchedAt });
      const [lng, lat] = pointAt(shape, shown);
      out.push({ ...v, shownDist: shown, lng, lat, bearing: bearingAt(shape, shown) });
    }
    for (const k of this.tracks.keys()) if (!seen.has(k)) this.tracks.delete(k);
    return out;
  }
}

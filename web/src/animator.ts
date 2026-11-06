import {
  bearingAt,
  DEFAULT_FOLLOWER_OPTIONS,
  estimateAll,
  followerStart,
  followerStep,
  pointAt,
  shapeForTrip,
  stopDistanceM,
  type EngineOptions,
  type EstimatedVehicle,
  type FollowerOptions,
  type FollowerState,
  type NetworkIndex,
  type PreparedTrip,
  type Shape,
} from '@myciti/shared';

export interface AnimatedVehicle extends EstimatedVehicle {
  /** displayed distance along the shape (smoothed) */
  shownDist: number;
  /** displayed speed, m/s */
  shownSpeedMps: number;
  lng: number;
  lat: number;
  bearing: number;
}

/**
 * Computes vehicle positions for every animation frame. The engine's estimate is the
 * target; the marker chases it like a vehicle would (see `followerStep`): bounded speed and
 * acceleration, never in reverse, and a gentle catch-up when fresh data moves the estimate.
 */
export class VehicleAnimator {
  private tracks = new Map<string, FollowerState>();
  private shapeCache = new WeakMap<PreparedTrip, Shape>();

  constructor(
    private idx: NetworkIndex,
    private readonly follower: FollowerOptions = DEFAULT_FOLLOWER_OPTIONS,
  ) {}

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
      const prev = this.tracks.get(key);
      let st = prev
        ? followerStep(prev, v.est.dist, v.est.speedMps, now, this.follower)
        : followerStart(v.est.dist, v.est.speedMps, now, this.follower);
      if (st.pos < 0 || st.pos > shape.length) st = { ...st, pos: Math.min(Math.max(st.pos, 0), shape.length) };
      this.tracks.set(key, st);
      const [lng, lat] = pointAt(shape, st.pos);
      out.push({ ...v, shownDist: st.pos, shownSpeedMps: st.speed, lng, lat, bearing: bearingAt(shape, st.pos) });
    }
    for (const k of this.tracks.keys()) if (!seen.has(k)) this.tracks.delete(k);
    return out;
  }
}

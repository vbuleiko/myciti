import type { LngLat } from './types';

const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LNG_EQ = 111_320;

/**
 * A polyline prepared for fast "distance along" queries. Uses a local equirectangular
 * projection (accurate to well under 0.1% over a city-sized area), so server and client
 * get identical numbers from identical input.
 */
export interface Shape {
  /** [lng, lat] */
  coords: LngLat[];
  /** planar metres */
  xs: Float64Array;
  ys: Float64Array;
  /** cumulative distance at each vertex, metres */
  cum: Float64Array;
  length: number;
  kx: number;
  ky: number;
  lng0: number;
  lat0: number;
}

export function buildShape(coordsIn: LngLat[]): Shape {
  // drop invalid and consecutive duplicate vertices
  const coords: LngLat[] = [];
  for (const c of coordsIn) {
    if (!c || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
    const last = coords[coords.length - 1];
    if (last && last[0] === c[0] && last[1] === c[1]) continue;
    coords.push([c[0], c[1]]);
  }
  const lat0 = coords.length ? coords.reduce((s, c) => s + c[1], 0) / coords.length : 0;
  const lng0 = coords.length ? coords[0]![0] : 0;
  const kx = M_PER_DEG_LNG_EQ * Math.cos((lat0 * Math.PI) / 180);
  const ky = M_PER_DEG_LAT;
  const n = coords.length;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const cum = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = (coords[i]![0] - lng0) * kx;
    ys[i] = (coords[i]![1] - lat0) * ky;
    if (i > 0) cum[i] = cum[i - 1]! + Math.hypot(xs[i]! - xs[i - 1]!, ys[i]! - ys[i - 1]!);
  }
  return { coords, xs, ys, cum, length: n ? cum[n - 1]! : 0, kx, ky, lng0, lat0 };
}

export function toXY(shape: Shape, p: LngLat): [number, number] {
  return [(p[0] - shape.lng0) * shape.kx, (p[1] - shape.lat0) * shape.ky];
}

/** Planar distance in metres between two lng/lat points (good for short distances). */
export function distanceM(a: LngLat, b: LngLat): number {
  const lat0 = (a[1] + b[1]) / 2;
  const kx = M_PER_DEG_LNG_EQ * Math.cos((lat0 * Math.PI) / 180);
  return Math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * M_PER_DEG_LAT);
}

export interface SegmentProjection {
  seg: number;
  /** perpendicular distance from the point to the segment, metres */
  offset: number;
  /** distance along the shape of the projected point, metres */
  along: number;
}

/** Project a point onto every segment of the shape. */
export function projectOnSegments(shape: Shape, p: LngLat): SegmentProjection[] {
  const [px, py] = toXY(shape, p);
  const out: SegmentProjection[] = [];
  const { xs, ys, cum } = shape;
  for (let i = 0; i < xs.length - 1; i++) {
    const ax = xs[i]!;
    const ay = ys[i]!;
    const dx = xs[i + 1]! - ax;
    const dy = ys[i + 1]! - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = ax + t * dx;
    const qy = ay + t * dy;
    out.push({ seg: i, offset: Math.hypot(px - qx, py - qy), along: cum[i]! + t * Math.sqrt(l2) });
  }
  return out;
}

/** Index of the segment containing distance `d` (binary search). */
function segmentAt(shape: Shape, d: number): number {
  const { cum } = shape;
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! <= d) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Point at distance `d` along the shape (clamped to its ends). */
export function pointAt(shape: Shape, d: number): LngLat {
  const { coords, cum } = shape;
  if (coords.length === 0) return [0, 0];
  if (coords.length === 1 || d <= 0) return [coords[0]![0], coords[0]![1]];
  if (d >= shape.length) {
    const last = coords[coords.length - 1]!;
    return [last[0], last[1]];
  }
  const i = segmentAt(shape, d);
  const segLen = cum[i + 1]! - cum[i]!;
  const t = segLen > 0 ? (d - cum[i]!) / segLen : 0;
  const a = coords[i]!;
  const b = coords[i + 1]!;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** Compass bearing (degrees, 0 = north, clockwise) of travel at distance `d`. */
export function bearingAt(shape: Shape, d: number, window = 20): number {
  if (shape.coords.length < 2) return 0;
  let a = Math.max(0, d - window);
  let b = Math.min(shape.length, d + window);
  if (b - a < 1) {
    a = Math.max(0, b - 2 * window);
    b = Math.min(shape.length, a + 2 * window);
  }
  const pa = toXY(shape, pointAt(shape, a));
  const pb = toXY(shape, pointAt(shape, b));
  const deg = (Math.atan2(pb[0] - pa[0], pb[1] - pa[1]) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** Sub-polyline between two distances, as [lng, lat] (used for highlighting). */
export function sliceShape(shape: Shape, from: number, to: number): LngLat[] {
  const a = Math.max(0, Math.min(from, to));
  const b = Math.min(shape.length, Math.max(from, to));
  const out: LngLat[] = [pointAt(shape, a)];
  for (let i = 0; i < shape.coords.length; i++) {
    const c = shape.cum[i]!;
    if (c > a && c < b) out.push(shape.coords[i]!);
  }
  out.push(pointAt(shape, b));
  return out;
}

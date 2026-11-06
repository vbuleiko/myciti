/**
 * Robust monotone fit of published passing times.
 *
 * The site's live times are not always monotone along the stop sequence (a later stop can be
 * stamped a minute or several earlier than the stop before it — typically a premature
 * detection). We keep the largest subset of observations that is consistent (non-decreasing
 * in time), preferring "Live" observations over plain schedule values and, among equally
 * large subsets, the one whose delay changes most smoothly. Dropped observations are
 * re-estimated by interpolating the delay of their kept neighbours, which keeps the result
 * monotone by construction.
 */

export interface FitInput {
  /** scheduled times in travel order (non-decreasing), any unit */
  sched: number[];
  /** published times in travel order */
  raw: number[];
  /** observation weight, e.g. 1 for live stops, 0.5 for schedule-only stops */
  weight?: number[];
}

export interface FitResult {
  fit: number[];
  outlier: boolean[];
}

export function robustMonotoneFit({ sched, raw, weight }: FitInput): FitResult {
  const n = raw.length;
  if (n === 0) return { fit: [], outlier: [] };
  const w = weight ?? raw.map(() => 1);
  const delay = raw.map((r, i) => r - sched[i]!);

  // DP for the max-weight non-decreasing subsequence, tie-break: min sum |Δdelay|
  const bestW = new Array<number>(n);
  const bestC = new Array<number>(n);
  const prev = new Array<number>(n);
  const EPS = 1e-9;
  for (let k = 0; k < n; k++) {
    bestW[k] = w[k]!;
    bestC[k] = 0;
    prev[k] = -1;
    for (let j = 0; j < k; j++) {
      if (raw[j]! > raw[k]!) continue;
      const cw = bestW[j]! + w[k]!;
      const cc = bestC[j]! + Math.abs(delay[k]! - delay[j]!);
      if (cw > bestW[k]! + EPS || (Math.abs(cw - bestW[k]!) <= EPS && cc < bestC[k]!)) {
        bestW[k] = cw;
        bestC[k] = cc;
        prev[k] = j;
      }
    }
  }
  let end = 0;
  for (let k = 1; k < n; k++) {
    if (bestW[k]! > bestW[end]! + EPS || (Math.abs(bestW[k]! - bestW[end]!) <= EPS && bestC[k]! < bestC[end]!)) end = k;
  }
  const kept = new Array<boolean>(n).fill(false);
  for (let k = end; k >= 0; k = prev[k]!) kept[k] = true;

  const fit = new Array<number>(n);
  const keptIdx: number[] = [];
  for (let k = 0; k < n; k++) if (kept[k]) keptIdx.push(k);

  let p = 0; // pointer into keptIdx: keptIdx[p] is the next kept index >= k
  for (let k = 0; k < n; k++) {
    while (p < keptIdx.length && keptIdx[p]! < k) p++;
    if (kept[k]) {
      fit[k] = raw[k]!;
      continue;
    }
    const after = p < keptIdx.length ? keptIdx[p]! : -1;
    const before = p > 0 ? keptIdx[p - 1]! : -1;
    let d: number;
    if (before >= 0 && after >= 0) {
      const span = sched[after]! - sched[before]!;
      const t = span > 0 ? (sched[k]! - sched[before]!) / span : 0.5;
      d = delay[before]! + (delay[after]! - delay[before]!) * t;
    } else if (before >= 0) d = delay[before]!;
    else if (after >= 0) d = delay[after]!;
    else d = 0;
    fit[k] = sched[k]! + d;
  }
  // numeric safety: enforce non-decreasing
  for (let k = 1; k < n; k++) if (fit[k]! < fit[k - 1]!) fit[k] = fit[k - 1]!;
  return { fit, outlier: kept.map((x) => !x) };
}

/**
 * Spread runs of equal times. A run of m consecutive stops with the same time T (the site only
 * has minute precision) is spread over [T, T + min(unit, Tnext - T)) proportionally to the
 * distance along the route (i.e. at uniform speed), or evenly if distances are unknown.
 */
export function spreadEqualTimes(times: number[], dist: number[] | null, unit: number): number[] {
  const out = times.slice();
  const n = times.length;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && Math.abs(times[j + 1]! - times[i]!) < 1e-6) j++;
    const m = j - i + 1;
    if (m > 1) {
      const T = times[i]!;
      const hasNext = j + 1 < n;
      const span = hasNext ? Math.min(unit, times[j + 1]! - T) : unit;
      const d0 = dist ? dist[i]! : 0;
      const dEnd = dist ? (hasNext ? dist[j + 1]! : dist[j]!) : 0;
      const byDist = dist !== null && dEnd - d0 > 1;
      for (let k = 1; k < m; k++) {
        const frac = byDist
          ? hasNext
            ? (dist[i + k]! - d0) / (dEnd - d0)
            : ((dist[i + k]! - d0) / (dEnd - d0)) * ((m - 1) / m)
          : k / m;
        out[i + k] = T + span * Math.min(Math.max(frac, 0), 1 - 1e-9);
      }
    }
    i = j + 1;
  }
  for (let k = 1; k < n; k++) if (out[k]! < out[k - 1]!) out[k] = out[k - 1]!;
  return out;
}

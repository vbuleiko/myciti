import { projectOnSegments, type Shape } from './geo';
import type { LngLat } from './types';

export interface MatchOptions {
  /** projections closer than this are considered candidates (metres) */
  candidateRadiusM: number;
  /** max candidates kept per stop */
  maxCandidates: number;
  /** cost per metre of going backwards along the shape (only used if no monotone solution) */
  backwardPenaltyPerM: number;
}

const DEFAULTS: MatchOptions = { candidateRadiusM: 200, maxCandidates: 8, backwardPenaltyPerM: 10 };

export interface StopMatch {
  /** distance along the shape, metres (non-decreasing over the sequence) */
  dist: number;
  /** distance from the stop to the shape, metres */
  offset: number;
}

interface Candidate {
  along: number;
  offset: number;
}

function candidatesFor(shape: Shape, p: LngLat, opts: MatchOptions): Candidate[] {
  const proj = projectOnSegments(shape, p);
  if (proj.length === 0) return [{ along: 0, offset: 0 }];
  // Local minima of the offset along the shape: one candidate per "pass" of the route near
  // the stop (loops and turnarounds pass the same place several times).
  let out: Candidate[] = [];
  for (let i = 0; i < proj.length; i++) {
    const cur = proj[i]!;
    if (cur.offset > opts.candidateRadiusM) continue;
    const prev = i > 0 ? proj[i - 1]!.offset : Infinity;
    const next = i + 1 < proj.length ? proj[i + 1]!.offset : Infinity;
    if (cur.offset <= prev && cur.offset <= next) out.push({ along: cur.along, offset: cur.offset });
  }
  // merge minima that are practically the same place along the shape
  out.sort((a, b) => a.along - b.along);
  const merged: Candidate[] = [];
  for (const c of out) {
    const last = merged[merged.length - 1];
    if (last && c.along - last.along < 25) {
      if (c.offset < last.offset) merged[merged.length - 1] = c;
    } else merged.push(c);
  }
  out = merged;
  if (out.length === 0) {
    // far from the shape: take the global best
    let best = proj[0]!;
    for (const pr of proj) if (pr.offset < best.offset) best = pr;
    out.push({ along: best.along, offset: best.offset });
  }
  out.sort((a, b) => a.offset - b.offset);
  return out.slice(0, opts.maxCandidates).sort((a, b) => a.along - b.along);
}

/**
 * Match an ordered list of stop positions to a shape so that the distances along the shape
 * never decrease ("monotone progress"), minimising the total stop-to-shape offset.
 * Dynamic programming over per-stop candidates (one per pass of the shape near the stop).
 */
export function matchStopsToShape(shape: Shape, points: LngLat[], options: Partial<MatchOptions> = {}): StopMatch[] {
  const opts = { ...DEFAULTS, ...options };
  if (points.length === 0) return [];
  if (shape.coords.length < 2) return points.map(() => ({ dist: 0, offset: 0 }));

  const cands = points.map((p) => candidatesFor(shape, p, opts));
  const cost: number[][] = [];
  const back: number[][] = [];
  cands.forEach((cs, k) => {
    cost[k] = [];
    back[k] = [];
    cs.forEach((c, ci) => {
      if (k === 0) {
        cost[k]![ci] = c.offset;
        back[k]![ci] = -1;
        return;
      }
      let best = Infinity;
      let arg = -1;
      cands[k - 1]!.forEach((pc, pi) => {
        const prev = cost[k - 1]![pi]!;
        const step = pc.along <= c.along + 1e-6 ? 0 : 1000 + (pc.along - c.along) * opts.backwardPenaltyPerM;
        const v = prev + step;
        if (v < best) {
          best = v;
          arg = pi;
        }
      });
      cost[k]![ci] = best + c.offset;
      back[k]![ci] = arg;
    });
  });

  const last = cands.length - 1;
  let ci = 0;
  cost[last]!.forEach((v, i) => {
    if (v < cost[last]![ci]!) ci = i;
  });
  const chosen: Candidate[] = new Array(cands.length);
  for (let k = last; k >= 0; k--) {
    chosen[k] = cands[k]![ci]!;
    ci = back[k]![ci]!;
  }
  // enforce monotonicity (only matters in the fallback case)
  const out: StopMatch[] = [];
  let runMax = 0;
  for (const c of chosen) {
    runMax = Math.max(runMax, c.along);
    out.push({ dist: runMax, offset: c.offset });
  }
  return out;
}

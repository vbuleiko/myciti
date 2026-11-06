import { describe, expect, it } from 'vitest';
import { bearingAt, buildShape, pointAt } from '../src/geo';
import { matchStopsToShape } from '../src/shape-match';
import type { LngLat } from '../src/types';

// ~111 m per 0.001 deg latitude; at -33.9 deg, 0.001 deg longitude ~ 92 m
const LAT = -33.9;
const LNG = 18.4;
const p = (dx: number, dy: number): LngLat => [LNG + dx * 0.001, LAT + dy * 0.001];

describe('shape geometry', () => {
  const straight = buildShape([p(0, 0), p(0, 10)]); // northwards ~1.1 km

  it('measures length and interpolates points', () => {
    expect(straight.length).toBeGreaterThan(1100);
    expect(straight.length).toBeLessThan(1110);
    const mid = pointAt(straight, straight.length / 2);
    expect(mid[1]).toBeCloseTo(LAT + 0.005, 6);
    expect(pointAt(straight, -5)).toEqual(p(0, 0));
    expect(pointAt(straight, 1e9)).toEqual(p(0, 10));
  });

  it('computes compass bearings', () => {
    expect(bearingAt(straight, 500)).toBeCloseTo(0, 3);
    const east = buildShape([p(0, 0), p(10, 0)]);
    expect(bearingAt(east, 300)).toBeCloseTo(90, 3);
    const south = buildShape([p(0, 10), p(0, 0)]);
    expect(bearingAt(south, 300)).toBeCloseTo(180, 3);
  });

  it('drops duplicate and invalid vertices', () => {
    const s = buildShape([p(0, 0), p(0, 0), [NaN, 1], p(0, 1)]);
    expect(s.coords).toHaveLength(2);
  });
});

describe('matchStopsToShape', () => {
  it('matches stops along a straight line', () => {
    const shape = buildShape([p(0, 0), p(0, 10)]);
    const m = matchStopsToShape(shape, [p(0.1, 0), p(-0.1, 5), p(0, 10)]);
    expect(m[0]!.dist).toBeCloseTo(0, 0);
    expect(m[1]!.dist).toBeCloseTo(shape.length / 2, -1);
    expect(m[2]!.dist).toBeCloseTo(shape.length, 0);
    expect(m[1]!.offset).toBeLessThan(15);
  });

  it('handles an out-and-back route (stop passed twice) with monotone progress', () => {
    // north 1.1 km, then back south on (almost) the same road
    const shape = buildShape([p(0, 0), p(0, 10), p(0.2, 10), p(0.2, 0)]);
    const stopA = p(0.1, 3); // between both carriageways
    const m = matchStopsToShape(shape, [p(0, 0), stopA, p(0.1, 10), stopA, p(0.2, 0)]);
    const d = m.map((x) => x.dist);
    expect(d.every((x, i) => i === 0 || x >= d[i - 1]!)).toBe(true);
    // first visit on the way out (~330 m), second on the way back (~2.2 km - 330 m)
    expect(d[1]!).toBeLessThan(500);
    expect(d[3]!).toBeGreaterThan(shape.length - 500);
  });

  it('handles a loop where the end returns to the start', () => {
    const shape = buildShape([p(0, 0), p(10, 0), p(10, 10), p(0, 10), p(0, 0)]);
    const m = matchStopsToShape(shape, [p(0, 0), p(10, 5), p(0, 0)]);
    expect(m[0]!.dist).toBeCloseTo(0, 0);
    expect(m[2]!.dist).toBeCloseTo(shape.length, 0);
  });

  it('never goes backwards, even for stops listed out of shape order', () => {
    const shape = buildShape([p(0, 0), p(0, 10)]);
    const m = matchStopsToShape(shape, [p(0, 6), p(0, 3), p(0, 9)]);
    const d = m.map((x) => x.dist);
    expect(d.every((x, i) => i === 0 || x >= d[i - 1]!)).toBe(true);
  });
});

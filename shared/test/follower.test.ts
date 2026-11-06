import { describe, expect, it } from 'vitest';
import { DEFAULT_FOLLOWER_OPTIONS, followerStart, followerStep, type FollowerState } from '../src/follower';

const O = DEFAULT_FOLLOWER_OPTIONS;

/** Run `seconds` of 100 ms frames against a target function of time (s). */
function run(s: FollowerState, target: (sec: number) => number, speed: (sec: number) => number, seconds: number, stepMs = 100) {
  const trace: FollowerState[] = [s];
  for (let ms = stepMs; ms <= seconds * 1000; ms += stepMs) {
    const sec = ms / 1000;
    s = followerStep(s, target(sec), speed(sec), s.t + stepMs);
    trace.push(s);
  }
  return { final: s, trace };
}

describe('followerStep', () => {
  it('starts on the target and tracks a target moving at constant speed', () => {
    const { final } = run(followerStart(0, 10, 0), (sec) => 10 * sec, () => 10, 30);
    expect(Math.abs(final.pos - 300)).toBeLessThan(1);
    expect(final.speed).toBeCloseTo(10, 1);
  });

  it('never reverses when the target jumps back, and lets it catch up', () => {
    const start = followerStart(500, 10, 0);
    // bus turned out to be 200 m behind where it was shown; target keeps moving at 10 m/s
    const { final, trace } = run(start, (sec) => 300 + 10 * sec, () => 10, 60);
    for (let i = 1; i < trace.length; i++) expect(trace[i]!.pos).toBeGreaterThanOrEqual(trace[i - 1]!.pos);
    expect(Math.abs(final.pos - 900)).toBeLessThan(2);
  });

  it('closes a forward gap smoothly within the speed and acceleration limits', () => {
    const start = followerStart(0, 10, 0);
    const { final, trace } = run(start, (sec) => 300 + 10 * sec, () => 10, 60);
    let vmax = 0;
    for (let i = 1; i < trace.length; i++) {
      const a = trace[i]!;
      const b = trace[i - 1]!;
      vmax = Math.max(vmax, a.speed);
      expect(a.speed - b.speed).toBeLessThanOrEqual(O.maxAccelMps2 * 0.1 + 1e-9);
      expect(b.speed - a.speed).toBeLessThanOrEqual(O.maxDecelMps2 * 0.1 + 1e-9);
    }
    expect(vmax).toBeLessThanOrEqual(O.maxSpeedMps);
    expect(vmax).toBeGreaterThan(10);
    expect(Math.abs(final.pos - 900)).toBeLessThan(2);
  });

  it('caps the displayed speed when the data implies an impossible one', () => {
    const { trace } = run(followerStart(0, 50, 0), (sec) => 50 * sec, () => 50, 10);
    for (const s of trace) expect(s.speed).toBeLessThanOrEqual(O.maxSpeedMps);
  });

  it('jumps for gaps too large to be a prediction error, and after a long pause', () => {
    const s = followerStart(0, 10, 0);
    expect(followerStep(s, 2000, 10, 100).pos).toBe(2000);
    expect(followerStart(0, 99, 0).speed).toBe(O.maxSpeedMps);
    expect(followerStep(s, -500, 10, 100).pos).toBe(-500);
    expect(followerStep(s, 100, 10, 10_000).pos).toBe(100); // 10 s without a frame
    expect(followerStep(s, 100, 10, 0)).toBe(s); // same frame
  });

  it('stops exactly at a target that is not moving', () => {
    const { final, trace } = run(followerStart(0, 10, 0), () => 50, () => 0, 30);
    expect(final.pos).toBe(50);
    expect(final.speed).toBe(0);
    for (const s of trace) expect(s.pos).toBeLessThanOrEqual(50);
  });
});

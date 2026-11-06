import { describe, expect, it } from 'vitest';
import { robustMonotoneFit, spreadEqualTimes } from '../src/robust-fit';

const hm = (s: string) => {
  const [h, m] = s.split(':').map(Number);
  return h! * 60 + m!;
};
const isNonDecreasing = (xs: number[]) => xs.every((x, i) => i === 0 || x >= xs[i - 1]!);

describe('robustMonotoneFit', () => {
  it('leaves monotone input untouched', () => {
    const sched = [0, 2, 5, 9];
    const raw = [1, 3, 5, 12];
    const r = robustMonotoneFit({ sched, raw });
    expect(r.fit).toEqual(raw);
    expect(r.outlier).toEqual([false, false, false, false]);
  });

  it('D01 trip 106900: a premature stamp at the 2nd stop is the outlier', () => {
    // travel order KUYASA, LNDLA, DIBANA, TUTU, DNYMBE
    const sched = ['14:55', '14:57', '14:59', '15:01', '15:03'].map(hm);
    const raw = ['15:15', '15:02', '15:19', '15:21', '15:22'].map(hm);
    const r = robustMonotoneFit({ sched, raw });
    expect(r.outlier).toEqual([false, true, false, false, false]);
    // re-estimated with the neighbours' delay (+20)
    expect(r.fit[1]).toBe(hm('15:17'));
    expect(isNonDecreasing(r.fit)).toBe(true);
  });

  it('101 trip 68740: keeps the smooth-delay subsequence', () => {
    // ANDAL GOVERN MICHAEL UPLOP LEUWN CHRCH MDLOP RIEBK ADLEY
    const sched = ['15:27', '15:29', '15:30', '15:32', '15:33', '15:34', '15:36', '15:37', '15:39'].map(hm);
    const raw = ['15:27', '15:29', '15:30', '15:28', '15:29', '15:33', '15:35', '15:34', '15:37'].map(hm);
    const r = robustMonotoneFit({ sched, raw });
    expect(r.outlier).toEqual([false, false, false, true, true, false, false, true, false]);
    expect(r.fit[3]).toBeCloseTo(hm('15:31') + 0.5); // delay interpolated 0 -> -1
    expect(r.fit[4]).toBeCloseTo(hm('15:32') + 0.25);
    expect(isNonDecreasing(r.fit)).toBe(true);
  });

  it('prefers live observations over schedule-only values', () => {
    // first stop schedule-only (bus not yet tracked), second live and 2 min early
    const sched = [100, 101, 105];
    const raw = [100, 99, 103];
    const r = robustMonotoneFit({ sched, raw, weight: [0.5, 1, 1] });
    expect(r.outlier).toEqual([true, false, false]);
    expect(r.fit[0]).toBe(98); // takes the live delay (-2)
  });

  it('a single late spike does not hold back the rest of the trip', () => {
    const sched = [0, 2, 4, 6, 8, 10];
    const raw = [0, 20, 4, 6, 8, 10];
    const r = robustMonotoneFit({ sched, raw });
    expect(r.outlier).toEqual([false, true, false, false, false, false]);
    expect(r.fit).toEqual([0, 2, 4, 6, 8, 10]);
  });

  it('always returns a non-decreasing sequence', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let t = 0; t < 200; t++) {
      const n = 2 + Math.floor(rnd() * 20);
      const sched: number[] = [];
      let s = 0;
      for (let i = 0; i < n; i++) sched.push((s += Math.floor(rnd() * 4)));
      const raw = sched.map((x) => x + Math.floor(rnd() * 21) - 10);
      const r = robustMonotoneFit({ sched, raw });
      expect(isNonDecreasing(r.fit)).toBe(true);
      expect(r.fit).toHaveLength(n);
    }
  });
});

describe('spreadEqualTimes', () => {
  const MIN = 60_000;

  it('spreads equal minute times evenly without distances', () => {
    const t = spreadEqualTimes([0, MIN, MIN, MIN, 2 * MIN], null, MIN);
    expect(t).toEqual([0, MIN, MIN + 20_000, MIN + 40_000, 2 * MIN]);
  });

  it('spreads at uniform speed when distances are known', () => {
    // run of 2 stops at minute 1, next stop at minute 2; distances 0, 100, 400
    const t = spreadEqualTimes([MIN, MIN, 2 * MIN], [0, 100, 400], MIN);
    expect(t[0]).toBe(MIN);
    expect(t[1]).toBeCloseTo(MIN + 15_000); // 100/400 of the minute
    expect(t[2]).toBe(2 * MIN);
  });

  it('keeps the run inside its minute even if the next stop is far later', () => {
    const t = spreadEqualTimes([0, 0, 0, 10 * MIN], [0, 100, 200, 3000], MIN);
    expect(t[2]!).toBeLessThan(MIN);
    expect(isNonDecreasing(t)).toBe(true);
  });

  it('handles a run at the end of the trip', () => {
    const t = spreadEqualTimes([0, 5 * MIN, 5 * MIN], [0, 1000, 1200], MIN);
    expect(t[1]).toBe(5 * MIN);
    expect(t[2]!).toBeGreaterThan(5 * MIN);
    expect(t[2]!).toBeLessThan(6 * MIN);
  });
});

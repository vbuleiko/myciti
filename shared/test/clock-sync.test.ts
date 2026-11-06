import { describe, expect, it } from 'vitest';
import { ClockSync } from '../src/clock-sync';

describe('ClockSync', () => {
  it('is zero until the first sample, then follows it', () => {
    const c = new ClockSync();
    expect(c.synced).toBe(false);
    expect(c.offsetMs).toBe(0);
    c.observe(1_000_300, 1_000_000);
    expect(c.synced).toBe(true);
    expect(c.offsetMs).toBe(300);
    expect(c.now(2_000_000)).toBe(2_000_300);
  });

  it('ignores latency spikes with a median', () => {
    const c = new ClockSync(5);
    for (const d of [300, 320, 2_900, 310, 290]) c.observe(1_000_000 + d, 1_000_000);
    expect(c.offsetMs).toBe(310);
  });

  it('resets the window after a real clock change', () => {
    const c = new ClockSync(5, 5_000);
    for (const d of [300, 310, 305]) c.observe(1_000_000 + d, 1_000_000);
    c.observe(1_000_000 + 60_300, 1_000_000); // local clock jumped back by a minute
    expect(c.offsetMs).toBe(60_300);
  });

  it('skips invalid samples', () => {
    const c = new ClockSync();
    c.observe(Number.NaN, 1);
    expect(c.synced).toBe(false);
  });
});

/**
 * Smoothed estimate of the server clock as seen from a client.
 *
 * Every message from the server carries `serverTime`. A single sample is off by the one-way
 * latency plus jitter; taking the median of the last few samples removes spikes, and a
 * sample far from the current estimate (laptop woke up, clock was adjusted) resets the window
 * so the estimate follows real changes quickly.
 */
export class ClockSync {
  private samples: number[] = [];
  private current: number | null = null;

  constructor(
    /** samples kept for the median */
    private readonly window = 7,
    /** a sample this far from the estimate resets the window, ms */
    private readonly resetMs = 5_000,
  ) {}

  /** Record a server timestamp received at local time `localNow` (both epoch ms). */
  observe(serverTime: number, localNow: number = Date.now()): number {
    if (!Number.isFinite(serverTime) || !Number.isFinite(localNow)) return this.offsetMs;
    const sample = serverTime - localNow;
    if (this.current !== null && Math.abs(sample - this.current) > this.resetMs) this.samples = [];
    this.samples.push(sample);
    if (this.samples.length > this.window) this.samples.shift();
    const sorted = [...this.samples].sort((a, b) => a - b);
    const m = sorted.length >> 1;
    this.current = sorted.length % 2 ? sorted[m]! : (sorted[m - 1]! + sorted[m]!) / 2;
    return this.current;
  }

  /** server clock - local clock, ms (0 until the first sample) */
  get offsetMs(): number {
    return this.current ?? 0;
  }

  get synced(): boolean {
    return this.current !== null;
  }

  /** Current server time estimate, epoch ms. */
  now(localNow: number = Date.now()): number {
    return localNow + this.offsetMs;
  }

  reset(): void {
    this.samples = [];
    this.current = null;
  }
}

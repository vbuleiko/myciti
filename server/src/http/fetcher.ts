import type { RobotsGuard } from './robots';

export interface FetcherOptions {
  userAgent: string;
  timeoutMs: number;
  /** max parallel requests to the site */
  maxConcurrency: number;
  /** min gap between request starts, ms */
  minGapMs: number;
  /** host-wide pause after 429 without Retry-After, ms (doubles on repeats) */
  rateLimitPauseMs?: number;
  /** pause the whole host after this many consecutive failures */
  hostFailureThreshold?: number;
  maxHostPauseMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface FetchResult {
  url: string;
  /** when the request actually started (after queueing), epoch ms */
  startedAt: number;
  status: number;
  body: string;
  bytes: number;
  durationMs: number;
}

export class FetchError extends Error {
  constructor(
    message: string,
    readonly kind: 'http' | 'timeout' | 'network' | 'robots',
    readonly status: number | null = null,
    /** suggested wait before retrying, ms */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

export interface FetcherStats {
  requests: number;
  errors: number;
  bytes: number;
  inFlight: number;
  hostPausedUntil: number;
  consecutiveHostFailures: number;
  lastRequestAt: number | null;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Parse Retry-After (seconds or HTTP date) into ms. */
export function parseRetryAfter(v: string | null, now: number): number | null {
  if (!v) return null;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

/**
 * A deliberately slow HTTP client for one host: robots.txt check, at most N parallel
 * requests, a minimum gap between request starts, timeouts, and a host-wide pause after
 * 429 responses or repeated failures.
 */
export class PoliteFetcher {
  private active = 0;
  private waiters: (() => void)[] = [];
  private turn: Promise<void> = Promise.resolve();
  private lastStart = 0;
  private hostPausedUntil = 0;
  private consecutiveFailures = 0;
  private rateLimitStreak = 0;
  private readonly o: Required<Omit<FetcherOptions, 'fetchImpl'>> & { fetchImpl: typeof fetch };
  readonly stats = { requests: 0, errors: 0, bytes: 0, lastRequestAt: null as number | null };

  constructor(
    opts: FetcherOptions,
    private readonly robots: RobotsGuard | null,
  ) {
    this.o = {
      rateLimitPauseMs: 120_000,
      hostFailureThreshold: 3,
      maxHostPauseMs: 30 * 60_000,
      fetchImpl: globalThis.fetch.bind(globalThis),
      now: Date.now,
      sleep: defaultSleep,
      ...opts,
    };
  }

  getStats(): FetcherStats {
    return {
      ...this.stats,
      inFlight: this.active,
      hostPausedUntil: this.hostPausedUntil,
      consecutiveHostFailures: this.consecutiveFailures,
    };
  }

  /** Extra spacing requested by robots.txt Crawl-delay, if any. */
  private gapMs(): number {
    const cd = this.robots?.status.crawlDelaySec;
    return Math.max(this.o.minGapMs, cd ? cd * 1000 : 0);
  }

  private async acquire(): Promise<void> {
    if (this.active < this.o.maxConcurrency) {
      this.active++;
      return;
    }
    await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
  }

  private release(): void {
    this.active--;
    this.waiters.shift()?.();
  }

  /** Serialise request starts so that they are at least gapMs apart and respect host pauses. */
  private async waitForTurn(): Promise<number> {
    const prev = this.turn;
    let done!: () => void;
    this.turn = new Promise<void>((r) => (done = r));
    await prev;
    try {
      for (;;) {
        const now = this.o.now();
        const wait = Math.max(this.lastStart + this.gapMs(), this.hostPausedUntil) - now;
        if (wait <= 0) break;
        await this.o.sleep(wait);
      }
      this.lastStart = this.o.now();
      return this.lastStart;
    } finally {
      done();
    }
  }

  private pauseHost(ms: number): void {
    this.hostPausedUntil = Math.max(this.hostPausedUntil, this.o.now() + Math.min(ms, this.o.maxHostPauseMs));
  }

  private noteFailure(): void {
    this.stats.errors++;
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.o.hostFailureThreshold) {
      const n = this.consecutiveFailures - this.o.hostFailureThreshold;
      this.pauseHost(30_000 * 2 ** Math.min(n, 8));
    }
  }

  async get(url: string): Promise<FetchResult> {
    if (this.robots && !this.robots.isAllowed(url)) {
      throw new FetchError(`blocked by robots.txt (${this.robots.status.state})`, 'robots');
    }
    await this.acquire();
    try {
      const started = await this.waitForTurn();
      this.stats.requests++;
      this.stats.lastRequestAt = started;
      let res: Response;
      let body: string;
      try {
        res = await this.o.fetchImpl(url, {
          headers: {
            'user-agent': this.o.userAgent,
            accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
            'accept-language': 'en',
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(this.o.timeoutMs),
        });
        body = await res.text();
      } catch (e) {
        this.noteFailure();
        const err = e as Error;
        const timeout = err.name === 'TimeoutError' || err.name === 'AbortError';
        throw new FetchError(
          timeout ? `timeout after ${this.o.timeoutMs} ms` : `network error: ${(err as { cause?: Error }).cause?.message ?? err.message}`,
          timeout ? 'timeout' : 'network',
        );
      }
      const durationMs = this.o.now() - started;
      const bytes = Buffer.byteLength(body);
      this.stats.bytes += bytes;

      if (res.status === 429 || res.status === 503) {
        this.stats.errors++;
        this.rateLimitStreak++;
        const ra = parseRetryAfter(res.headers.get('retry-after'), this.o.now());
        const pause = Math.max(ra ?? 0, this.o.rateLimitPauseMs * 2 ** Math.min(this.rateLimitStreak - 1, 4));
        this.pauseHost(pause);
        throw new FetchError(`HTTP ${res.status}`, 'http', res.status, pause);
      }
      if (res.status >= 500) {
        this.noteFailure();
        throw new FetchError(`HTTP ${res.status}`, 'http', res.status);
      }
      if (!res.ok) {
        this.stats.errors++;
        throw new FetchError(`HTTP ${res.status}`, 'http', res.status);
      }
      this.consecutiveFailures = 0;
      this.rateLimitStreak = 0;
      return { url, startedAt: started, status: res.status, body, bytes, durationMs };
    } finally {
      this.release();
    }
  }
}

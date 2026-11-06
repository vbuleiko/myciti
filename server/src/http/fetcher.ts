import type { RobotsGuard } from './robots';

export interface FetcherOptions {
  userAgent: string;
  timeoutMs: number;
  /** max parallel requests to the site */
  maxConcurrency: number;
  /** min gap between request starts, ms */
  minGapMs: number;
  /** hard ceiling on request starts per rolling minute (0 = none) */
  requestsPerMinute?: number;
  /** responses larger than this (decoded bytes) are abandoned */
  maxBodyBytes?: number;
  /** only this host may answer (after redirects); derived from the first URL when omitted */
  host?: string;
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

export type FetchErrorKind = 'http' | 'timeout' | 'network' | 'robots' | 'redirect' | 'too-large';

export class FetchError extends Error {
  constructor(
    message: string,
    readonly kind: FetchErrorKind,
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
  /** exponential moving average of the response time of completed requests, ms */
  avgDurationMs: number | null;
  /** request starts in the last rolling minute */
  requestsLastMinute: number;
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

/** Read a response body as UTF-8, giving up once it exceeds `maxBytes` decoded bytes. */
export async function readBodyLimited(res: Response, maxBytes: number): Promise<{ text: string; bytes: number }> {
  if (!res.body) {
    const text = await res.text();
    return { text, bytes: Buffer.byteLength(text) };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new FetchError(`response larger than ${Math.round(maxBytes / 1_048_576)} MB`, 'too-large');
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), bytes: total };
}

/**
 * A deliberately slow HTTP client for one host: robots.txt check, at most N parallel
 * requests, a minimum gap between request starts, a per-minute budget, timeouts, a size cap,
 * and a host-wide pause after 429 responses or repeated failures. Redirects that leave the
 * host are refused, so the parser never sees a page from somewhere else.
 */
export class PoliteFetcher {
  private active = 0;
  private waiters: (() => void)[] = [];
  private turn: Promise<void> = Promise.resolve();
  private lastStart = 0;
  private recentStarts: number[] = [];
  private hostPausedUntil = 0;
  private consecutiveFailures = 0;
  private rateLimitStreak = 0;
  private avgDurationMs: number | null = null;
  private host: string | null;
  private readonly o: Required<Omit<FetcherOptions, 'fetchImpl' | 'host'>> & { fetchImpl: typeof fetch };
  readonly stats = { requests: 0, errors: 0, bytes: 0, lastRequestAt: null as number | null };

  constructor(
    opts: FetcherOptions,
    private readonly robots: RobotsGuard | null,
  ) {
    this.o = {
      requestsPerMinute: 0,
      maxBodyBytes: 48 * 1_048_576,
      rateLimitPauseMs: 120_000,
      hostFailureThreshold: 3,
      maxHostPauseMs: 30 * 60_000,
      fetchImpl: globalThis.fetch.bind(globalThis),
      now: Date.now,
      sleep: defaultSleep,
      ...opts,
    };
    this.host = opts.host ?? null;
  }

  getStats(): FetcherStats {
    const now = this.o.now();
    return {
      ...this.stats,
      inFlight: this.active,
      hostPausedUntil: this.hostPausedUntil,
      consecutiveHostFailures: this.consecutiveFailures,
      avgDurationMs: this.avgDurationMs === null ? null : Math.round(this.avgDurationMs),
      requestsLastMinute: this.recentStarts.filter((t) => t > now - 60_000).length,
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

  /** Earliest moment a new request may start given the per-minute budget. */
  private budgetWaitMs(now: number): number {
    const budget = this.o.requestsPerMinute;
    if (budget <= 0) return 0;
    this.recentStarts = this.recentStarts.filter((t) => t > now - 60_000);
    if (this.recentStarts.length < budget) return 0;
    return this.recentStarts[this.recentStarts.length - budget]! + 60_000 - now;
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
        const wait = Math.max(this.lastStart + this.gapMs(), this.hostPausedUntil, now + this.budgetWaitMs(now)) - now;
        if (wait <= 0) break;
        await this.o.sleep(wait);
      }
      this.lastStart = this.o.now();
      this.recentStarts.push(this.lastStart);
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

  private noteDuration(ms: number): void {
    this.avgDurationMs = this.avgDurationMs === null ? ms : this.avgDurationMs * 0.7 + ms * 0.3;
  }

  async get(url: string): Promise<FetchResult> {
    if (this.robots && !this.robots.isAllowed(url)) {
      throw new FetchError(`blocked by robots.txt (${this.robots.status.state})`, 'robots');
    }
    const wantHost = this.host ?? (this.host = safeHost(url));
    await this.acquire();
    try {
      const started = await this.waitForTurn();
      this.stats.requests++;
      this.stats.lastRequestAt = started;
      let res: Response;
      let body: string;
      let bytes: number;
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
        const finalHost = res.url ? safeHost(res.url) : wantHost;
        if (wantHost && finalHost && finalHost !== wantHost) {
          await res.body?.cancel().catch(() => undefined);
          throw new FetchError(`redirected off-site to ${finalHost}`, 'redirect', res.status);
        }
        ({ text: body, bytes } = await readBodyLimited(res, this.o.maxBodyBytes));
      } catch (e) {
        this.noteFailure();
        if (e instanceof FetchError) throw e;
        const err = e as Error;
        const timeout = err.name === 'TimeoutError' || err.name === 'AbortError';
        throw new FetchError(
          timeout ? `timeout after ${this.o.timeoutMs} ms` : `network error: ${(err as { cause?: Error }).cause?.message ?? err.message}`,
          timeout ? 'timeout' : 'network',
        );
      }
      const durationMs = this.o.now() - started;
      this.noteDuration(durationMs);
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

function safeHost(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

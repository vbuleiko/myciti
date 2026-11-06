import { describe, expect, it } from 'vitest';
import { FetchError, parseRetryAfter, PoliteFetcher } from '../src/http/fetcher';
import { RobotsGuard } from '../src/http/robots';

function harness(responder: (url: string) => { status: number; body?: string; headers?: Record<string, string> }) {
  let t = 1_000_000;
  let active = 0;
  let maxActive = 0;
  const starts: number[] = [];
  const fetchImpl = (async (url: string) => {
    starts.push(t);
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 2));
    active--;
    const r = responder(url);
    return new Response(r.body ?? 'ok', { status: r.status, headers: r.headers });
  }) as unknown as typeof fetch;
  const robots = new RobotsGuard('https://example.test', 'ua', 'myciti-live-map');
  robots.setRules('User-agent: *\nDisallow: /private/\n');
  const fetcher = new PoliteFetcher(
    {
      userAgent: 'test',
      timeoutMs: 5000,
      maxConcurrency: 2,
      minGapMs: 1000,
      fetchImpl,
      now: () => t,
      sleep: async (ms) => {
        await new Promise((r) => setTimeout(r, 0));
        t += ms;
      },
    },
    robots,
  );
  return { fetcher, starts, get maxActive() { return maxActive; }, get t() { return t; } };
}

describe('PoliteFetcher', () => {
  it('spaces request starts and caps concurrency at 2', async () => {
    const h = harness(() => ({ status: 200 }));
    const res = await Promise.all([1, 2, 3, 4, 5].map((i) => h.fetcher.get(`https://example.test/p${i}`)));
    expect(h.maxActive).toBeLessThanOrEqual(2);
    const starts = res.map((r) => r.startedAt).sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(1000);
    expect(h.fetcher.getStats().requests).toBe(5);
  });

  it('honours robots.txt', async () => {
    const h = harness(() => ({ status: 200 }));
    await expect(h.fetcher.get('https://example.test/private/x')).rejects.toMatchObject({ kind: 'robots' });
    expect(h.starts).toHaveLength(0);
  });

  it('pauses the whole host after 429 (Retry-After)', async () => {
    let n = 0;
    const h = harness(() => (n++ === 0 ? { status: 429, headers: { 'retry-after': '300' } } : { status: 200 }));
    const err = (await h.fetcher.get('https://example.test/a').catch((e) => e)) as FetchError;
    expect(err).toBeInstanceOf(FetchError);
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBeGreaterThanOrEqual(300_000);
    const ok = await h.fetcher.get('https://example.test/b');
    expect(ok.startedAt - h.starts[0]!).toBeGreaterThanOrEqual(300_000);
  });

  it('backs off the host after repeated server errors', async () => {
    const h = harness(() => ({ status: 502 }));
    for (let i = 0; i < 3; i++) await h.fetcher.get('https://example.test/x').catch(() => undefined);
    expect(h.fetcher.getStats().hostPausedUntil).toBeGreaterThan(h.t + 20_000);
  });

  it('parses Retry-After', () => {
    expect(parseRetryAfter('120', 0)).toBe(120_000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 0)).toBe(10_000);
    expect(parseRetryAfter(null, 0)).toBeNull();
  });
});

describe('RobotsGuard', () => {
  it('treats 4xx robots.txt as allow-all and unreachable as disallow-all', async () => {
    const g = new RobotsGuard('https://example.test', 'ua', 'myciti-live-map');
    expect(g.isAllowed('https://example.test/x')).toBe(false); // unknown yet
    g.status = { ...g.status, state: 'allow-all' };
    expect(g.isAllowed('https://example.test/x')).toBe(true);
    g.status = { ...g.status, state: 'unreachable' };
    expect(g.isAllowed('https://example.test/x')).toBe(false);
  });

  it('applies agent-specific rules and crawl delay', () => {
    const g = new RobotsGuard('https://example.test', 'ua', 'myciti-live-map');
    g.setRules('User-agent: myciti-live-map\nDisallow: /en/timetables/\nCrawl-delay: 5\n\nUser-agent: *\nDisallow:\n');
    expect(g.isAllowed('https://example.test/en/timetables/route-timetables/?route=101')).toBe(false);
    expect(g.isAllowed('https://example.test/en/routes-stops/')).toBe(true);
    expect(g.status.crawlDelaySec).toBe(5);
  });
});

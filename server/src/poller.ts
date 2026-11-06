import { addDays, localMidnight, MIN_MS, type PreparedTrip } from '@myciti/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config';
import { FetchError, type PoliteFetcher } from './http/fetcher';
import { parseTimetablePage } from './parser/timetable';
import type { NetworkStore } from './stores/network-store';
import type { RealtimeStore } from './stores/realtime-store';

export type PollMode = 'startup' | 'live' | 'untracked' | 'idle' | 'night' | 'error' | 'blocked';

export interface PlanConfig {
  pollLiveMs: number;
  pollUntrackedMs: number;
  pollIdleMaxMs: number;
  leadMs: number;
  timezone: string;
}

export interface PollPlan {
  mode: PollMode;
  delayMs: number;
  reason: string;
}

/**
 * Decide when to poll a route page again, from its latest snapshot:
 * - buses being tracked (or service running on a route that has live data) -> every pollLive
 * - service running, but the route has no live data at all today -> every pollUntracked
 * - no service right now -> sleep until shortly before the next departure (capped)
 * - no more service today -> sleep until shortly before tomorrow's first departure
 */
export function planNextPoll(trips: PreparedTrip[], now: number, cfg: PlanConfig): PollPlan {
  const lead = cfg.leadMs;
  let liveActive = 0;
  let serviceActive = 0;
  let anyLive = false;
  let nextStart = Infinity;
  let earliestClock = Infinity; // ms after local midnight of the earliest departure
  for (const t of trips) {
    if (t.stops.length === 0) continue;
    const f = t.stops[0]!;
    const l = t.stops[t.stops.length - 1]!;
    const start = Math.min(f.sched, f.fit);
    const end = Math.max(l.sched, l.fit);
    if (t.live) anyLive = true;
    if (t.live && f.fit - lead <= now && now <= l.fit + 2 * MIN_MS) liveActive++;
    if (start - lead <= now && now <= end + 5 * MIN_MS) serviceActive++;
    if (start > now) nextStart = Math.min(nextStart, start);
    earliestClock = Math.min(earliestClock, f.sched - localMidnight(f.sched, cfg.timezone));
  }
  if (liveActive > 0) return { mode: 'live', delayMs: cfg.pollLiveMs, reason: `${liveActive} live trip(s) in progress` };
  if (serviceActive > 0) {
    return anyLive
      ? { mode: 'live', delayMs: cfg.pollLiveMs, reason: `${serviceActive} trip(s) scheduled now, waiting for live data` }
      : { mode: 'untracked', delayMs: cfg.pollUntrackedMs, reason: `${serviceActive} trip(s) scheduled now, no live data today` };
  }
  if (Number.isFinite(nextStart)) {
    const d = Math.min(Math.max(nextStart - lead - now, cfg.pollLiveMs), cfg.pollIdleMaxMs);
    return { mode: 'idle', delayMs: d, reason: `next departure ${new Date(nextStart).toISOString()}` };
  }
  // nothing left today: aim for tomorrow's first departure (same clock time as today's first)
  const tomorrow = addDays(localMidnight(now, cfg.timezone), 1, cfg.timezone);
  const firstClock = Number.isFinite(earliestClock) ? earliestClock : 4 * 60 * MIN_MS;
  const target = tomorrow + firstClock - Math.max(lead, 30 * MIN_MS);
  const d = Math.min(Math.max(target - now, 30 * MIN_MS), 12 * 60 * MIN_MS);
  return { mode: 'night', delayMs: d, reason: 'no more service today' };
}

export interface RouteState {
  routeId: string;
  mode: PollMode;
  reason: string;
  nextDueAt: number;
  inFlight: boolean;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  lastHttpStatus: number | null;
  consecutiveErrors: number;
  lastDurationMs: number | null;
  lastBytes: number | null;
  polls: number;
}

export function routeTimetablePath(routeId: string): string {
  return `/en/timetables/route-timetables/?route=${encodeURIComponent(routeId)}`;
}

/** Poll route pages one by one, spreading requests evenly, at most maxConcurrency at a time. */
export class Poller {
  readonly states = new Map<string, RouteState>();
  private timer: NodeJS.Timeout | null = null;
  running = false;
  private inFlight = 0;

  constructor(
    private readonly cfg: Config,
    private readonly fetcher: PoliteFetcher,
    private readonly network: NetworkStore,
    private readonly realtime: RealtimeStore,
    private readonly log: FastifyBaseLogger,
    private readonly now: () => number = Date.now,
  ) {}

  private planCfg(): PlanConfig {
    return {
      pollLiveMs: this.cfg.pollLiveSec * 1000,
      pollUntrackedMs: this.cfg.pollUntrackedSec * 1000,
      pollIdleMaxMs: this.cfg.pollIdleMaxSec * 1000,
      leadMs: this.cfg.pollLeadSec * 1000,
      timezone: this.cfg.timezone,
    };
  }

  /** Route ids to poll: configured list, or every route of the network. */
  routeIds(): string[] {
    if (this.cfg.routes.length) return this.cfg.routes;
    return this.network.network?.routes.map((r) => r.id) ?? [];
  }

  /**
   * (Re)build the route list. New routes get their first poll spread evenly over one live
   * interval; routes with a snapshot saved by a previous run continue on their schedule.
   */
  syncRoutes(): void {
    const ids = this.routeIds();
    const now = this.now();
    const fresh = ids.filter((id) => !this.states.has(id));
    const spread = this.cfg.pollLiveSec * 1000;
    fresh.forEach((routeId, i) => {
      const stagger = now + Math.round((i * spread) / Math.max(fresh.length, 1));
      const saved = this.realtime.get(routeId);
      const plan = saved ? planNextPoll(saved.trips, now, this.planCfg()) : null;
      this.states.set(routeId, {
        routeId,
        mode: plan ? plan.mode : 'startup',
        reason: plan ? `resumed from saved snapshot; ${plan.reason}` : 'initial fetch',
        nextDueAt: saved && plan ? Math.max(stagger, saved.fetchedAt + plan.delayMs) : stagger,
        inFlight: false,
        lastAttemptAt: saved?.fetchedAt ?? null,
        lastSuccessAt: saved?.fetchedAt ?? null,
        lastError: null,
        lastHttpStatus: null,
        consecutiveErrors: 0,
        lastDurationMs: null,
        lastBytes: null,
        polls: 0,
      });
    });
    for (const id of [...this.states.keys()]) if (!ids.includes(id)) this.states.delete(id);
  }

  start(): void {
    this.running = true;
    this.syncRoutes();
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), Math.max(0, Math.min(ms, 30_000)));
  }

  private tick(): void {
    const now = this.now();
    while (this.inFlight < this.cfg.maxConcurrency) {
      let due: RouteState | null = null;
      for (const s of this.states.values()) {
        if (s.inFlight || s.nextDueAt > now) continue;
        if (!due || s.nextDueAt < due.nextDueAt) due = s;
      }
      if (!due) break;
      void this.poll(due);
    }
    let next = Infinity;
    for (const s of this.states.values()) if (!s.inFlight) next = Math.min(next, s.nextDueAt);
    this.schedule(Number.isFinite(next) ? next - now : 30_000);
  }

  /** Fetch one route page now (also used by tests). */
  async poll(state: RouteState): Promise<void> {
    state.inFlight = true;
    this.inFlight++;
    const started = this.now();
    state.lastAttemptAt = started;
    state.polls++;
    try {
      const res = await this.fetcher.get(this.cfg.baseUrl + routeTimetablePath(state.routeId));
      state.lastHttpStatus = res.status;
      state.lastDurationMs = res.durationMs;
      state.lastBytes = res.bytes;
      const page = parseTimetablePage(res.body, state.routeId);
      const fetchedAt = res.startedAt + Math.round(res.durationMs / 2); // middle of the request
      const snap = this.realtime.update(state.routeId, page.directions, fetchedAt, page.warnings);
      state.lastSuccessAt = this.now();
      state.lastError = null;
      state.consecutiveErrors = 0;
      const plan = planNextPoll(snap?.trips ?? [], this.now(), this.planCfg());
      state.mode = plan.mode;
      state.reason = plan.reason;
      // anchor the cadence to the actual request start: a page is never requested more often
      // than plan.delayMs (>= POLL_LIVE_SEC >= 60 s), and polls stay evenly spread
      state.nextDueAt = Math.max(res.startedAt + plan.delayMs, this.now() + 5_000);
      this.log.debug({ route: state.routeId, mode: plan.mode, ms: res.durationMs, kb: Math.round(res.bytes / 1024) }, 'route polled');
    } catch (e) {
      const err = e as Error;
      state.consecutiveErrors++;
      state.lastError = err.message;
      if (e instanceof FetchError) state.lastHttpStatus = e.status;
      const blocked = e instanceof FetchError && e.kind === 'robots';
      const base = this.cfg.backoffBaseSec * 1000 * 2 ** Math.min(state.consecutiveErrors - 1, 10);
      let delay = Math.min(base, this.cfg.backoffMaxSec * 1000);
      if (e instanceof FetchError && e.retryAfterMs) delay = Math.max(delay, e.retryAfterMs);
      if (blocked) delay = 60 * 60_000;
      delay = Math.round(delay * (0.8 + Math.random() * 0.4));
      state.mode = blocked ? 'blocked' : 'error';
      state.reason = err.message;
      state.nextDueAt = this.now() + delay;
      this.log.warn({ route: state.routeId, err: err.message, retryInSec: Math.round(delay / 1000) }, 'route poll failed');
    } finally {
      state.inFlight = false;
      this.inFlight--;
      this.schedule(0);
    }
  }
}

import {
  bearingAt,
  estimateAll,
  pointAt,
  shapeForTrip,
  stopDistanceM,
  type EngineOptions,
  type PreparedTrip,
} from '@myciti/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Config } from './config';
import type { PoliteFetcher } from './http/fetcher';
import type { RobotsGuard } from './http/robots';
import { slowOriginFactor, type Poller } from './poller';
import type { NetworkStore } from './stores/network-store';
import type { ObservationLog } from './stores/observation-log';
import { tripsInWindow, type RealtimeStore, type RouteSnapshot } from './stores/realtime-store';

export interface ApiDeps {
  cfg: Config;
  engine: EngineOptions;
  network: NetworkStore;
  realtime: RealtimeStore;
  poller: Poller;
  fetcher: PoliteFetcher;
  robots: RobotsGuard;
  observations: ObservationLog | null;
  startedAt: number;
}

const ROUTE_ID_RE = /^[A-Za-z0-9_-]{1,16}$/;
const MAX_FILTER_ROUTES = 200;

/**
 * `?routes=101,T01` -> set of route ids; null = no filter. Ids that do not look like route
 * ids are dropped (nothing is ever echoed back), and a filter with no valid id matches nothing.
 */
export function routeFilter(q: unknown): Set<string> | null {
  const raw = (q as { routes?: unknown } | undefined)?.routes;
  if (typeof raw !== 'string' || raw === '') return null;
  const ids = raw
    .split(',', MAX_FILTER_ROUTES + 1)
    .map((x) => x.trim())
    .filter((x) => ROUTE_ID_RE.test(x))
    .slice(0, MAX_FILTER_ROUTES);
  return new Set(ids);
}

/** Value for Access-Control-Allow-Origin on the hijacked SSE response (null = no header). */
export function corsAllowOrigin(configured: string, requestOrigin: string | undefined): string | null {
  if (configured === '*') return '*';
  if (!requestOrigin) return null;
  const allowed = configured.split(',').map((x) => x.trim()).filter(Boolean);
  return allowed.includes(requestOrigin) ? requestOrigin : null;
}

/** A client that stops reading gets this much buffered before it is dropped. */
const SSE_MAX_BUFFERED_BYTES = 1_048_576;

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function registerApi(app: FastifyInstance, d: ApiDeps): { close: () => void } {
  const { cfg, engine, network, realtime, poller } = d;
  const stopDist = (a: string, b: string) => (network.idx ? stopDistanceM(network.idx, a, b) : Infinity);

  const notReady = (reply: FastifyReply) =>
    reply.code(503).header('retry-after', '10').send({ error: 'network not loaded yet', network: network.status });

  // ---------------------------------------------------------------- /api/network
  app.get('/api/network', async (req, reply) => {
    if (!network.json) return notReady(reply);
    reply.header('etag', network.etag).header('cache-control', 'public, max-age=300');
    if (req.headers['if-none-match'] === network.etag) return reply.code(304).send();
    return reply.type('application/json; charset=utf-8').send(network.json);
  });

  // ---------------------------------------------------------------- /api/trips/live
  const routesMeta = (snaps: RouteSnapshot[]) =>
    Object.fromEntries(snaps.map((s) => [s.routeId, { fetchedAt: s.fetchedAt, day: s.day, serviceAdvisory: s.serviceAdvisory }]));

  app.get('/api/trips/live', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const now = Date.now();
    const filter = routeFilter(req.query);
    const all = (req.query as { all?: string }).all === '1';
    const snaps = realtime.all().filter((s) => !filter || filter.has(s.routeId));
    const trips: PreparedTrip[] = [];
    for (const s of snaps) trips.push(...(all ? s.trips : tripsInWindow(s.trips, now)));
    return { serverTime: now, engine, routes: routesMeta(snaps), trips };
  });

  // ---------------------------------------------------------------- /api/vehicles
  app.get('/api/vehicles', async (req, reply) => {
    if (!network.idx) return notReady(reply);
    reply.header('cache-control', 'no-store');
    const idx = network.idx;
    const now = Date.now();
    const filter = routeFilter(req.query);
    const trips = realtime.all().flatMap((s) => (!filter || filter.has(s.routeId) ? tripsInWindow(s.trips, now) : []));
    const vehicles = estimateAll(trips, now, stopDist, engine);
    const features = vehicles.map(({ trip, est, mergedFrom }) => {
      const shape = shapeForTrip(idx, trip.routeId, trip.directionId, trip.stops.map((s) => s.stopId));
      const [lng, lat] = pointAt(shape, est.dist);
      const route = idx.routes.get(trip.routeId);
      const prev = trip.stops[est.prevIdx]!;
      const next = trip.stops[est.nextIdx]!;
      return {
        type: 'Feature' as const,
        id: trip.key,
        geometry: { type: 'Point' as const, coordinates: [Math.round(lng * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6] },
        properties: {
          key: trip.key,
          routeId: trip.routeId,
          routeName: route?.name ?? trip.routeId,
          color: route?.color ?? '#3366CC',
          textColor: route?.textColor ?? '#FFFFFF',
          directionId: trip.directionId,
          tripId: trip.tripId,
          headsign: trip.headsign,
          state: est.state,
          bearing: Math.round(bearingAt(shape, est.dist)),
          distAlong: Math.round(est.dist),
          prevStop: { id: prev.stopId, name: prev.name, sched: prev.sched, time: prev.fit },
          nextStop: { id: next.stopId, name: next.name, sched: next.sched, time: next.fit },
          delaySec: Math.round(est.delaySec),
          speedKmh: Math.round(est.speedMps * 3.6),
          suspect: trip.suspect,
          mergedFrom: mergedFrom ?? null,
          dataFetchedAt: trip.fetchedAt,
          dataAgeSec: Math.round((now - trip.fetchedAt) / 1000),
          estimated: true,
        },
      };
    });
    return { type: 'FeatureCollection', serverTime: now, features };
  });

  // ---------------------------------------------------------------- /api/stream (SSE)
  const clients = new Set<FastifyReply['raw']>();
  const drop = (res: FastifyReply['raw']) => {
    clients.delete(res);
    if (!res.destroyed) res.destroy();
  };
  const send = (res: FastifyReply['raw'], event: string, data: unknown) => {
    if (res.destroyed || res.writableEnded) {
      clients.delete(res);
      return;
    }
    // a client that stopped reading must not make the server buffer without bound
    if (res.writableLength > SSE_MAX_BUFFERED_BYTES) {
      drop(res);
      return;
    }
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const broadcast = (event: string, data: unknown) => {
    if (clients.size === 0) return;
    const payload = JSON.stringify(data);
    for (const c of clients) send(c, event, JSON.parse(payload) as unknown);
  };

  app.get('/api/stream', (req, reply) => {
    if (clients.size >= cfg.maxSseClients) {
      return reply.code(503).header('retry-after', '30').header('cache-control', 'no-store').send({ error: 'too many stream clients' });
    }
    reply.hijack();
    const res = reply.raw;
    const headers: Record<string, string> = {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
    };
    const allow = corsAllowOrigin(cfg.corsOrigin, req.headers.origin);
    if (allow) {
      headers['access-control-allow-origin'] = allow;
      if (allow !== '*') headers.vary = 'origin';
    }
    res.writeHead(200, headers);
    req.raw.socket?.setKeepAlive(true, 30_000);
    req.raw.socket?.setNoDelay(true);
    res.write('retry: 5000\n\n');
    send(res, 'hello', { serverTime: Date.now() });
    clients.add(res);
    req.raw.on('close', () => clients.delete(res));
    res.on('error', () => clients.delete(res));
  });

  const onRoute = (snap: RouteSnapshot) => {
    if (clients.size === 0) return;
    const now = Date.now();
    const payload = {
      serverTime: now,
      routeId: snap.routeId,
      route: { fetchedAt: snap.fetchedAt, day: snap.day, serviceAdvisory: snap.serviceAdvisory },
      trips: tripsInWindow(snap.trips, now),
    };
    const text = `event: route\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const c of clients) {
      if (c.destroyed || c.writableEnded) clients.delete(c);
      else if (c.writableLength > SSE_MAX_BUFFERED_BYTES) drop(c);
      else c.write(text);
    }
  };
  realtime.on('route', onRoute);
  const onNetwork = () => broadcast('network', { fetchedAt: network.status.fetchedAt, etag: network.etag });
  network.on('updated', onNetwork);
  const heartbeat = setInterval(() => broadcast('ping', { serverTime: Date.now() }), 20_000);
  heartbeat.unref();

  // ---------------------------------------------------------------- /api/health
  app.get('/api/health', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    const now = Date.now();
    const vehicles = network.idx ? estimateAll(realtime.allTrips(), now, stopDist, engine) : [];
    const byRoute = new Map<string, { active: number; suspect: number; delays: number[] }>();
    for (const v of vehicles) {
      const r = byRoute.get(v.trip.routeId) ?? { active: 0, suspect: 0, delays: [] };
      r.active++;
      if (v.trip.suspect) r.suspect++;
      else r.delays.push(v.est.delaySec / 60);
      byRoute.set(v.trip.routeId, r);
    }
    let errors = 0;
    let stale = 0;
    const routes: Record<string, unknown> = {};
    for (const s of poller.states.values()) {
      const snap = realtime.get(s.routeId);
      const ageSec = snap ? Math.round((now - snap.fetchedAt) / 1000) : null;
      const st = byRoute.get(s.routeId);
      if (s.consecutiveErrors > 0) errors++;
      if (s.mode === 'live' && ageSec !== null && ageSec > cfg.pollLiveSec * 3) stale++;
      const med = st ? median(st.delays) : null;
      routes[s.routeId] = {
        mode: s.mode,
        reason: s.reason,
        dataAgeSec: ageSec,
        dataFetchedAt: snap?.fetchedAt ?? null,
        lastAttemptAt: s.lastAttemptAt,
        lastSuccessAt: s.lastSuccessAt,
        nextPollInSec: Math.max(0, Math.round((s.nextDueAt - now) / 1000)),
        polls: s.polls,
        consecutiveErrors: s.consecutiveErrors,
        lastError: s.lastError,
        lastHttpStatus: s.lastHttpStatus,
        lastDurationMs: s.lastDurationMs,
        lastKB: s.lastBytes === null ? null : Math.round(s.lastBytes / 1024),
        day: snap?.day ?? null,
        serviceAdvisory: snap?.serviceAdvisory ?? null,
        trips: snap?.trips.length ?? 0,
        liveTrips: snap?.trips.filter((t) => t.live).length ?? 0,
        suspectTrips: snap?.trips.filter((t) => t.suspect).length ?? 0,
        vehiclesNow: st?.active ?? 0,
        suspectVehiclesNow: st?.suspect ?? 0,
        medianDelayMinNow: med === null ? null : Math.round(med * 10) / 10,
        warnings: snap?.warnings ?? [],
      };
    }
    const fetcherStats = d.fetcher.getStats();
    const slowFactor = slowOriginFactor(fetcherStats.avgDurationMs, cfg.slowOriginMs, cfg.slowOriginMaxFactor);
    const status = !network.network ? 'error' : errors || stale || network.status.lastError ? 'degraded' : 'ok';
    return {
      status,
      serverTime: now,
      uptimeSec: Math.round((now - d.startedAt) / 1000),
      vehiclesNow: vehicles.length,
      network: {
        ...network.status,
        ageSec: network.status.fetchedAt ? Math.round((now - network.status.fetchedAt) / 1000) : null,
        warnings: network.status.warnings.length,
      },
      robots: { url: d.robots.url, ...d.robots.status },
      fetcher: { ...fetcherStats, slowOriginFactor: Math.round(slowFactor * 100) / 100 },
      observations: d.observations ? await d.observations.status() : { enabled: false },
      sseClients: clients.size,
      config: {
        routes: cfg.routes.length ? cfg.routes : 'all',
        pollLiveSec: cfg.pollLiveSec,
        pollUntrackedSec: cfg.pollUntrackedSec,
        pollIdleMaxSec: cfg.pollIdleMaxSec,
        maxConcurrency: cfg.maxConcurrency,
        minRequestGapMs: cfg.minRequestGapMs,
        maxRequestsPerMin: cfg.maxRequestsPerMin,
        slowOriginMs: cfg.slowOriginMs,
        maxDataAgeMin: cfg.maxDataAgeMin,
        maxSseClients: cfg.maxSseClients,
        observationsKeepDays: cfg.observationsKeepDays,
      },
      routes,
    };
  });

  return {
    close: () => {
      clearInterval(heartbeat);
      realtime.off('route', onRoute);
      network.off('updated', onNetwork);
      for (const c of clients) if (!c.destroyed) c.end();
      clients.clear();
    },
  };
}

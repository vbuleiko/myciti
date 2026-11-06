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
import type { Poller } from './poller';
import type { NetworkStore } from './stores/network-store';
import { tripsInWindow, type RealtimeStore, type RouteSnapshot } from './stores/realtime-store';

export interface ApiDeps {
  cfg: Config;
  engine: EngineOptions;
  network: NetworkStore;
  realtime: RealtimeStore;
  poller: Poller;
  fetcher: PoliteFetcher;
  robots: RobotsGuard;
  startedAt: number;
}

function routeFilter(q: unknown): Set<string> | null {
  const raw = (q as { routes?: string } | undefined)?.routes;
  if (!raw) return null;
  const s = new Set(raw.split(',').map((x) => x.trim()).filter(Boolean));
  return s.size ? s : null;
}

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

  app.get('/api/trips/live', async (req) => {
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
  const send = (res: FastifyReply['raw'], event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  app.get('/api/stream', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'access-control-allow-origin': cfg.corsOrigin === '*' ? '*' : (req.headers.origin ?? ''),
    });
    res.write('retry: 5000\n\n');
    send(res, 'hello', { serverTime: Date.now() });
    clients.add(res);
    req.raw.on('close', () => clients.delete(res));
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
    for (const c of clients) send(c, 'route', payload);
  };
  realtime.on('route', onRoute);
  const onNetwork = () => {
    for (const c of clients) send(c, 'network', { fetchedAt: network.status.fetchedAt, etag: network.etag });
  };
  network.on('updated', onNetwork);
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const c of clients) send(c, 'ping', { serverTime: now });
  }, 20_000);
  heartbeat.unref();

  // ---------------------------------------------------------------- /api/health
  app.get('/api/health', async () => {
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
      fetcher: d.fetcher.getStats(),
      sseClients: clients.size,
      config: {
        routes: cfg.routes.length ? cfg.routes : 'all',
        pollLiveSec: cfg.pollLiveSec,
        pollUntrackedSec: cfg.pollUntrackedSec,
        pollIdleMaxSec: cfg.pollIdleMaxSec,
        maxConcurrency: cfg.maxConcurrency,
        minRequestGapMs: cfg.minRequestGapMs,
      },
      routes,
    };
  });

  return {
    close: () => {
      clearInterval(heartbeat);
      realtime.off('route', onRoute);
      network.off('updated', onNetwork);
      for (const c of clients) c.end();
      clients.clear();
    },
  };
}

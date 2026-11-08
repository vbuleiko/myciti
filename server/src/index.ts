import compress from '@fastify/compress';
import cors from '@fastify/cors';
import { DEFAULT_ENGINE_OPTIONS, type EngineOptions, type RawDirectionTimetable } from '@myciti/shared';
import Fastify, { LogController, type FastifyError } from 'fastify';
import { join } from 'node:path';
import { registerApi } from './api';
import { loadConfig } from './config';
import { PoliteFetcher } from './http/fetcher';
import { RobotsGuard } from './http/robots';
import { Poller } from './poller';
import { NetworkStore } from './stores/network-store';
import { ObservationLog } from './stores/observation-log';
import { RealtimeStore, type RouteSnapshot } from './stores/realtime-store';
import { registerWeb } from './web';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const cfg = loadConfig();
  const startedAt = Date.now();
  const app = Fastify({
    logger: { level: cfg.logLevel },
    logController: new LogController({ disableRequestLogging: true }),
    // the API is read-only: no bodies, short URLs, no slow-loris headers
    bodyLimit: 16 * 1024,
    maxParamLength: 200,
    requestTimeout: 30_000,
    keepAliveTimeout: 65_000,
    // X-Forwarded-For is only meaningful behind the bundled nginx
    trustProxy: cfg.trustProxy,
  });
  await app.register(cors, {
    origin: cfg.corsOrigin === '*' ? true : cfg.corsOrigin.split(',').map((s) => s.trim()).filter(Boolean),
    methods: ['GET', 'HEAD', 'OPTIONS'],
  });
  await app.register(compress, { threshold: 1024 });
  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
  });
  if (cfg.webDist) {
    // one process serves the map and the API (no nginx): see docs/macos-server.md
    await registerWeb(app, cfg.webDist);
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not found' }));
  }
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err }, 'request failed');
    // never leak stack traces or internal messages for server-side failures
    reply.code(status).send({ error: status >= 500 ? 'internal error' : err.message });
  });

  const engine: EngineOptions = {
    ...DEFAULT_ENGINE_OPTIONS,
    preDepartureMs: cfg.preDepartureMin * 60_000,
    postArrivalMs: cfg.postArrivalMin * 60_000,
    suspectThresholdMs: cfg.suspectThresholdMin * 60_000,
    terminalMergeMaxGapMs: cfg.terminalMergeMaxGapMin * 60_000,
    maxDataAgeMs: cfg.maxDataAgeMin * 60_000,
  };

  const robots = new RobotsGuard(cfg.baseUrl, cfg.userAgent, cfg.robotsAgent);
  const fetcher = new PoliteFetcher(
    {
      userAgent: cfg.userAgent,
      timeoutMs: cfg.requestTimeoutMs,
      maxConcurrency: cfg.maxConcurrency,
      minGapMs: cfg.minRequestGapMs,
      requestsPerMinute: cfg.maxRequestsPerMin,
      maxBodyBytes: cfg.maxBodyMb * 1_048_576,
      host: new URL(cfg.baseUrl).host.toLowerCase(),
    },
    robots,
  );
  const network = new NetworkStore(fetcher, cfg.baseUrl, cfg.dataDir, cfg.networkRefreshHours * 3_600_000, app.log);
  const realtime = new RealtimeStore(() => network.idx, cfg.timezone, engine, join(cfg.dataDir, 'routes'));
  const poller = new Poller(cfg, fetcher, network, realtime, app.log);
  const observations = cfg.observations
    ? new ObservationLog({ dir: cfg.observationsDir, tz: cfg.timezone, keepDays: cfg.observationsKeepDays })
    : null;
  if (observations) {
    observations.on('error', (e: Error) => app.log.error({ err: e }, 'observation log write failed'));
    realtime.on('polled', (snap: RouteSnapshot, directions: RawDirectionTimetable[]) =>
      observations.record(snap.routeId, directions, snap.trips, snap.fetchedAt),
    );
  }
  network.on('updated', () => {
    realtime.reprepareAll();
    if (poller.running) poller.syncRoutes();
  });

  const api = registerApi(app, { cfg, engine, network, realtime, poller, fetcher, robots, observations, startedAt });
  await app.listen({ host: cfg.host, port: cfg.port });
  app.log.info({ web: cfg.webDist ?? 'off', data: cfg.dataDir }, cfg.webDist ? 'serving the web map and the API' : 'serving the API only');

  // robots.txt: re-check daily, or every 10 minutes while it is unreachable
  const robotsLoop = async () => {
    for (;;) {
      const st = await robots.refresh();
      app.log.info({ state: st.state, status: st.httpStatus, crawlDelay: st.crawlDelaySec, err: st.error }, 'robots.txt checked');
      await sleep(st.state === 'unreachable' ? 10 * 60_000 : 24 * 3_600_000);
    }
  };

  let stopping = false;
  const bootstrap = async () => {
    // first robots check happens inside robotsLoop; wait for it
    while (!stopping && robots.status.state === 'unknown') await sleep(200);
    while (!stopping) {
      if (robots.status.state !== 'unreachable') {
        await network.init();
        if (network.network) break;
      }
      app.log.warn('network not available yet; retrying in 5 minutes');
      await sleep(5 * 60_000);
    }
    if (!stopping && observations) {
      try {
        const replayed = await observations.init();
        observations.state.retain(poller.routeIds());
        observations.startMaintenance();
        app.log.info({ dir: observations.dir, replayed }, 'observation log ready');
      } catch (e) {
        app.log.error({ err: e }, 'observation log unavailable; history is not being recorded');
      }
    }
    if (!stopping) {
      await realtime.loadSaved(cfg.pollIdleMaxSec * 1000);
      realtime.retain(poller.routeIds());
      const resumed = realtime.all().length;
      if (resumed) app.log.info({ routes: resumed }, 'resumed route snapshots saved by the previous run');
      poller.start();
      app.log.info({ routes: poller.routeIds().length }, 'poller started');
    }
  };
  void robotsLoop();
  void bootstrap();

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    app.log.info({ signal }, 'shutting down');
    poller.stop();
    network.stop();
    api.close();
    if (observations) {
      observations.stopMaintenance();
      await observations.flush();
    }
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

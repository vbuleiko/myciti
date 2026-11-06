import compress from '@fastify/compress';
import cors from '@fastify/cors';
import { DEFAULT_ENGINE_OPTIONS, type EngineOptions } from '@myciti/shared';
import Fastify from 'fastify';
import { join } from 'node:path';
import { registerApi } from './api';
import { loadConfig } from './config';
import { PoliteFetcher } from './http/fetcher';
import { RobotsGuard } from './http/robots';
import { Poller } from './poller';
import { NetworkStore } from './stores/network-store';
import { RealtimeStore } from './stores/realtime-store';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const cfg = loadConfig();
  const startedAt = Date.now();
  const app = Fastify({ logger: { level: cfg.logLevel }, disableRequestLogging: true });
  await app.register(cors, { origin: cfg.corsOrigin === '*' ? true : cfg.corsOrigin.split(',') });
  await app.register(compress, { threshold: 1024 });

  const engine: EngineOptions = {
    ...DEFAULT_ENGINE_OPTIONS,
    preDepartureMs: cfg.preDepartureMin * 60_000,
    postArrivalMs: cfg.postArrivalMin * 60_000,
    suspectThresholdMs: cfg.suspectThresholdMin * 60_000,
    terminalMergeMaxGapMs: cfg.terminalMergeMaxGapMin * 60_000,
  };

  const robots = new RobotsGuard(cfg.baseUrl, cfg.userAgent, cfg.robotsAgent);
  const fetcher = new PoliteFetcher(
    {
      userAgent: cfg.userAgent,
      timeoutMs: cfg.requestTimeoutMs,
      maxConcurrency: cfg.maxConcurrency,
      minGapMs: cfg.minRequestGapMs,
    },
    robots,
  );
  const network = new NetworkStore(fetcher, cfg.baseUrl, cfg.dataDir, cfg.networkRefreshHours * 3_600_000, app.log);
  const realtime = new RealtimeStore(() => network.idx, cfg.timezone, engine, join(cfg.dataDir, 'routes'));
  const poller = new Poller(cfg, fetcher, network, realtime, app.log);
  network.on('updated', () => {
    realtime.reprepareAll();
    if (poller.running) poller.syncRoutes();
  });

  const api = registerApi(app, { cfg, engine, network, realtime, poller, fetcher, robots, startedAt });
  await app.listen({ host: cfg.host, port: cfg.port });

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

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { indexNetwork, type NetworkIndex } from '@myciti/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { PoliteFetcher } from '../http/fetcher';
import { parseNetworkPage, type ParsedNetwork } from '../parser/network';

export const NETWORK_PATH = '/en/routes-stops/route-stop-station-map/';

export interface NetworkStatus {
  fetchedAt: number | null;
  source: 'site' | 'cache' | null;
  lastAttemptAt: number | null;
  lastError: string | null;
  warnings: string[];
  routes: number;
  stops: number;
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** Static network (routes, stops, traces): refreshed daily, cached on disk. */
export class NetworkStore extends EventEmitter {
  network: ParsedNetwork | null = null;
  idx: NetworkIndex | null = null;
  /** pre-serialised /api/network payload */
  json = '';
  etag = '';
  status: NetworkStatus = { fetchedAt: null, source: null, lastAttemptAt: null, lastError: null, warnings: [], routes: 0, stops: 0 };
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly fetcher: PoliteFetcher,
    private readonly baseUrl: string,
    private readonly dataDir: string,
    private readonly refreshMs: number,
    private readonly log: FastifyBaseLogger,
  ) {
    super();
  }

  private get cacheFile(): string {
    return join(this.dataDir, 'network.json');
  }

  /** Use the disk cache if it is fresh enough, otherwise fetch. Retries until it has a network. */
  async init(): Promise<void> {
    const cached = await this.loadCache();
    if (cached) {
      this.apply(cached, 'cache');
      this.log.info({ fetchedAt: new Date(cached.fetchedAt).toISOString() }, 'network loaded from cache');
    }
    if (!cached || Date.now() - cached.fetchedAt >= this.refreshMs) {
      await this.refresh();
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    const age = this.status.fetchedAt ? Date.now() - this.status.fetchedAt : Infinity;
    // refresh when due; retry a failed refresh after 15 min
    const due = this.status.lastError ? 15 * 60_000 : Math.max(60_000, this.refreshMs - age);
    this.timer = setTimeout(() => {
      void this.refresh().finally(() => this.schedule());
    }, due);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  async refresh(): Promise<boolean> {
    this.status.lastAttemptAt = Date.now();
    try {
      const res = await this.fetcher.get(this.baseUrl + NETWORK_PATH);
      const parsed = parseNetworkPage(res.body, Date.now());
      this.apply(parsed, 'site');
      this.status.lastError = null;
      await this.saveCache(parsed);
      this.log.info(
        { routes: parsed.routes.length, stops: parsed.stops.length, warnings: parsed.warnings.length, ms: res.durationMs },
        'network refreshed',
      );
      return true;
    } catch (e) {
      this.status.lastError = (e as Error).message;
      this.log.error({ err: (e as Error).message }, 'network refresh failed');
      return false;
    }
  }

  private apply(net: ParsedNetwork, source: 'site' | 'cache'): void {
    this.network = net;
    this.idx = indexNetwork(net.routes, net.stops);
    const payload = {
      fetchedAt: net.fetchedAt,
      routes: net.routes.map((r) => ({
        ...r,
        directions: r.directions.map((d) => ({ ...d, shape: d.shape.map(([x, y]) => [round6(x), round6(y)]) })),
      })),
      stops: net.stops,
    };
    this.json = JSON.stringify(payload);
    this.etag = `"${createHash('sha1').update(this.json).digest('base64url').slice(0, 20)}"`;
    this.status = {
      ...this.status,
      fetchedAt: net.fetchedAt,
      source,
      warnings: net.warnings,
      routes: net.routes.length,
      stops: net.stops.length,
    };
    this.emit('updated', net);
  }

  private async loadCache(): Promise<ParsedNetwork | null> {
    try {
      const data = JSON.parse(await readFile(this.cacheFile, 'utf8')) as ParsedNetwork;
      if (!Array.isArray(data.routes) || !Array.isArray(data.stops) || !data.fetchedAt) return null;
      return data;
    } catch {
      return null;
    }
  }

  private async saveCache(net: ParsedNetwork): Promise<void> {
    try {
      await mkdir(this.dataDir, { recursive: true });
      const tmp = `${this.cacheFile}.tmp`;
      await writeFile(tmp, JSON.stringify(net));
      await rename(tmp, this.cacheFile);
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, 'could not write network cache');
    }
  }
}

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseDotenv } from 'dotenv';

/** Load .env from the server dir and the repo root (server dir wins); real env vars win over both. */
function loadDotenv(): void {
  for (const file of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '..', '.env')]) {
    if (!existsSync(file)) continue;
    const vars = parseDotenv(readFileSync(file));
    for (const [k, v] of Object.entries(vars)) if (process.env[k] === undefined) process.env[k] = v;
  }
}

function num(name: string, def: number, min?: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return def;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`config: ${name} must be a number, got "${raw}"`);
  if (min !== undefined && v < min) {
    console.warn(`config: ${name}=${v} is below the minimum ${min}; using ${min}`);
    return min;
  }
  return v;
}

function bool(name: string, def: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function str(name: string, def: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? def : raw.trim();
}

export interface Config {
  host: string;
  port: number;
  logLevel: string;
  baseUrl: string;
  userAgent: string;
  /** robots.txt product token */
  robotsAgent: string;
  timezone: string;
  /** empty = all routes from the network map */
  routes: string[];
  /** routes with buses being tracked: seconds between polls of one route page (>= 60) */
  pollLiveSec: number;
  /** routes with scheduled service but no live tracking today */
  pollUntrackedSec: number;
  /** max seconds between checks of a route that has no service right now */
  pollIdleMaxSec: number;
  /** start polling this long before the first scheduled departure */
  pollLeadSec: number;
  maxConcurrency: number;
  /** minimum gap between the starts of two requests to the site, ms */
  minRequestGapMs: number;
  /** hard ceiling on requests to the site per rolling minute */
  maxRequestsPerMin: number;
  /** abandon responses larger than this (decoded) */
  maxBodyMb: number;
  /** when the site's average response time exceeds this, poll less often */
  slowOriginMs: number;
  /** ...up to this multiple of the normal interval */
  slowOriginMaxFactor: number;
  requestTimeoutMs: number;
  backoffBaseSec: number;
  backoffMaxSec: number;
  networkRefreshHours: number;
  dataDir: string;
  /** append every change of a published stop time to a daily log (history for later analysis) */
  observations: boolean;
  /** directory of the observation log */
  observationsDir: string;
  /** delete observation files older than this many days (0 = keep forever) */
  observationsKeepDays: number;
  suspectThresholdMin: number;
  preDepartureMin: number;
  postArrivalMin: number;
  terminalMergeMaxGapMin: number;
  /** hide buses whose snapshot is older than this (0 = never) */
  maxDataAgeMin: number;
  corsOrigin: string;
  /** concurrent /api/stream connections accepted */
  maxSseClients: number;
  /** believe X-Forwarded-* headers (only behind a reverse proxy you control) */
  trustProxy: boolean;
}

export function loadConfig(): Config {
  loadDotenv();
  const routes = str('ROUTES', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    host: str('HOST', '0.0.0.0'),
    port: num('PORT', 3000),
    logLevel: str('LOG_LEVEL', 'info'),
    baseUrl: str('MYCITI_BASE_URL', 'https://www.myciti.org.za').replace(/\/+$/, ''),
    userAgent: str(
      'USER_AGENT',
      'myciti-live-map/0.1 (+https://github.com/vbuleiko/myciti; unofficial, polls each route page at most once a minute)',
    ),
    robotsAgent: str('ROBOTS_AGENT', 'myciti-live-map'),
    timezone: str('TIMEZONE', 'Africa/Johannesburg'),
    routes,
    pollLiveSec: num('POLL_LIVE_SEC', 60, 60),
    pollUntrackedSec: num('POLL_UNTRACKED_SEC', 180, 60),
    pollIdleMaxSec: num('POLL_IDLE_MAX_SEC', 3600, 60),
    pollLeadSec: num('POLL_LEAD_SEC', 600, 0),
    maxConcurrency: Math.min(num('MAX_CONCURRENCY', 2, 1), 2),
    minRequestGapMs: num('MIN_REQUEST_GAP_MS', 1000, 250),
    maxRequestsPerMin: Math.min(num('MAX_REQUESTS_PER_MIN', 45, 1), 60),
    maxBodyMb: num('MAX_BODY_MB', 48, 1),
    slowOriginMs: num('SLOW_ORIGIN_MS', 15_000, 1000),
    slowOriginMaxFactor: num('SLOW_ORIGIN_MAX_FACTOR', 3, 1),
    requestTimeoutMs: num('REQUEST_TIMEOUT_MS', 45_000, 5_000),
    backoffBaseSec: num('BACKOFF_BASE_SEC', 30, 5),
    backoffMaxSec: num('BACKOFF_MAX_SEC', 1800, 60),
    networkRefreshHours: num('NETWORK_REFRESH_HOURS', 24, 1),
    dataDir: resolve(process.cwd(), str('DATA_DIR', './data')),
    observations: bool('OBSERVATIONS', true),
    observationsDir: resolve(process.cwd(), str('OBSERVATIONS_DIR', join(str('DATA_DIR', './data'), 'observations'))),
    observationsKeepDays: num('OBSERVATIONS_KEEP_DAYS', 0, 0),
    suspectThresholdMin: num('SUSPECT_THRESHOLD_MIN', 30, 1),
    preDepartureMin: num('PRE_DEPARTURE_MIN', 5, 0),
    postArrivalMin: num('POST_ARRIVAL_MIN', 1, 0),
    terminalMergeMaxGapMin: num('TERMINAL_MERGE_MAX_GAP_MIN', 10, 0),
    maxDataAgeMin: num('MAX_DATA_AGE_MIN', 20, 0),
    corsOrigin: str('CORS_ORIGIN', '*'),
    maxSseClients: num('MAX_SSE_CLIENTS', 200, 1),
    trustProxy: bool('TRUST_PROXY', false),
  };
}

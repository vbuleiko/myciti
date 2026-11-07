/**
 * Inspect the observation log (history of published stop times) written by the server.
 *
 *   pnpm observations -- summary                              # what has been collected
 *   pnpm observations -- export --from 2026-11-07 --to 2026-11-20 --out stop-times.csv
 *   pnpm observations -- report --from 2026-11-07 [--routes 101,T01] [--csv punctuality.csv]
 *
 * Options: --dir <path> (default: OBSERVATIONS_DIR from the config), --routes a,b,c,
 * --from / --to (service dates, inclusive). `export` writes one row per trip and stop with the
 * scheduled and the actual (final `Live`) time; `report` prints punctuality per route,
 * direction and hour of departure.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatClock, type NetworkRoute, type NetworkStop } from '@myciti/shared';
import { loadConfig } from '../src/config';
import { csvLine, punctualityRows, reconstructDayAsync, stopTimeRows, type StopTimeRow } from '../src/observation-report';
import { listLogFiles, readLogFile } from '../src/stores/observation-log';

const args = process.argv.slice(2);
const command = args.find((a) => !a.startsWith('--')) ?? 'summary';
const arg = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const cfg = loadConfig();
const dir = arg('dir') ?? cfg.observationsDir;
const tz = cfg.timezone;
const from = arg('from') ?? '0000-00-00';
const to = arg('to') ?? '9999-99-99';
const routes = arg('routes')?.split(',').map((s) => s.trim()).filter(Boolean);

const files = (await listLogFiles(dir)).filter(([d]) => d >= from && d <= to);
if (!files.length) {
  console.error(`no observation files in ${dir}${from !== '0000-00-00' || to !== '9999-99-99' ? ` for ${from}..${to}` : ''}`);
  process.exit(1);
}

// names from the cached network, if the server has saved one
const stopNames = new Map<string, string>();
const headsigns = new Map<string, string>();
const netFile = join(cfg.dataDir, 'network.json');
if (existsSync(netFile)) {
  try {
    const net = JSON.parse(readFileSync(netFile, 'utf8')) as { routes: NetworkRoute[]; stops: NetworkStop[] };
    for (const s of net.stops) stopNames.set(s.id, s.name);
    for (const r of net.routes) for (const d of r.directions) headsigns.set(`${r.id}:${d.directionId}`, d.headsign);
  } catch {
    // names are optional
  }
}

const iso = (s: number | null) => (s === null ? '' : new Date(s * 1000).toISOString());
const clock = (s: number | null) => (s === null || !Number.isFinite(s) ? '' : formatClock(s * 1000, tz));

async function* days() {
  for (const [date, file] of files) yield { date, file, day: await reconstructDayAsync(date, readLogFile(file)) };
}

if (command === 'summary') {
  console.log(`observation log: ${dir}\n`);
  console.log('date        file                     polls  routes  trips  tracked  stops  actual  changes');
  let totalTrips = 0;
  let totalActual = 0;
  for await (const { date, file, day } of days()) {
    const rows = stopTimeRows(day).filter((r) => !routes || routes.includes(r.routeId));
    const trips = new Set(rows.map((r) => `${r.routeId}:${r.tripId}`)).size;
    const tracked = new Set(rows.filter((r) => r.tracked).map((r) => `${r.routeId}:${r.tripId}`)).size;
    const actual = rows.filter((r) => r.actual !== null).length;
    const changes = rows.reduce((n, r) => n + r.revisions, 0);
    totalTrips += tracked;
    totalActual += actual;
    console.log(
      `${date}  ${file.slice(dir.length + 1).padEnd(24)} ${String(day.polls).padStart(5)}  ${String(day.routes.size).padStart(6)}  ${String(trips).padStart(5)}  ${String(tracked).padStart(7)}  ${String(rows.length).padStart(5)}  ${String(actual).padStart(6)}  ${String(changes).padStart(7)}`,
    );
  }
  console.log(`\n${files.length} day(s), ${totalTrips} tracked trip(s), ${totalActual} actual stop time(s)`);
} else if (command === 'export') {
  const out = arg('out') ?? `stop-times-${files[0]![0]}-${files[files.length - 1]![0]}.csv`;
  const lines = [
    csvLine([
      'service_date', 'route', 'direction', 'headsign', 'trip_id', 'seq', 'stop_id', 'stop_name',
      'sched_local', 'actual_local', 'delay_min', 'sched_utc', 'actual_utc', 'first_live_utc', 'last_change_utc',
      'revisions', 'tracked',
    ]),
  ];
  let n = 0;
  for await (const { day } of days()) {
    for (const r of stopTimeRows(day)) {
      if (routes && !routes.includes(r.routeId)) continue;
      lines.push(
        csvLine([
          r.serviceDate, r.routeId, r.directionId, headsigns.get(`${r.routeId}:${r.directionId}`) ?? '', r.tripId, r.seq,
          r.stopId, stopNames.get(r.stopId) ?? '', clock(r.sched), clock(r.actual), r.delayMin, iso(r.sched), iso(r.actual),
          iso(r.firstLiveAt), iso(r.lastChangeAt), r.revisions, r.tracked,
        ]),
      );
      n++;
    }
  }
  writeFileSync(out, lines.join('\n') + '\n');
  console.log(`${n} stop time row(s) written to ${out}`);
} else if (command === 'report') {
  const rows: StopTimeRow[] = [];
  for await (const { day } of days()) for (const r of stopTimeRows(day)) if (!routes || routes.includes(r.routeId)) rows.push(r);
  const table = punctualityRows(rows, tz);
  const fmt = (x: number | null, w: number, pct = false) => (x === null ? '-' : pct ? `${Math.round(x * 100)}%` : String(x)).padStart(w);
  console.log(`${files[0]![0]}..${files[files.length - 1]![0]} (${files.length} day(s))\n`);
  console.log('route  dir  hour  sched  tracked  complete  dep.med  arr.med  arr.p85  on-time  run/sched');
  for (const r of table) {
    console.log(
      `${r.routeId.padEnd(6)} ${String(r.directionId).padStart(3)}  ${(r.hour < 0 ? 'all' : String(r.hour).padStart(2, '0')).padStart(4)}  ${String(r.tripsScheduled).padStart(5)}  ${String(r.tripsTracked).padStart(7)}  ${String(r.tripsComplete).padStart(8)}  ${fmt(r.departureDelayMedian, 7)}  ${fmt(r.arrivalDelayMedian, 7)}  ${fmt(r.arrivalDelayP85, 7)}  ${fmt(r.onTimeShare, 7, true)}  ${fmt(r.runTimeRatioMedian, 9)}`,
    );
  }
  const csv = arg('csv');
  if (csv) {
    const lines = [
      csvLine(['route', 'direction', 'hour', 'trips_scheduled', 'trips_tracked', 'trips_complete', 'departure_delay_median_min', 'arrival_delay_median_min', 'arrival_delay_p85_min', 'on_time_share', 'run_time_ratio_median']),
      ...table.map((r) =>
        csvLine([r.routeId, r.directionId, r.hour, r.tripsScheduled, r.tripsTracked, r.tripsComplete, r.departureDelayMedian, r.arrivalDelayMedian, r.arrivalDelayP85, r.onTimeShare, r.runTimeRatioMedian]),
      ),
    ];
    writeFileSync(csv, lines.join('\n') + '\n');
    console.log(`\n${table.length} row(s) written to ${csv}`);
  }
} else {
  console.error(`unknown command "${command}"; use summary, export or report`);
  process.exit(2);
}

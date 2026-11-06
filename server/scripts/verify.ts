/**
 * Acceptance check: compare the server's estimated positions with the route timetable pages
 * fetched at the same moment.
 *
 *   pnpm verify                      # routes 101,T01,D01 against http://localhost:3000
 *   pnpm verify -- --routes 101,T04 --server http://localhost:3000
 *
 * For every bus the server shows on those routes we fetch the route page (one request per
 * route, 2 s apart) and check that "now" lies between the published times of the stops the
 * bus is placed between (minute precision), and that the bus lies between those stops along
 * the route.
 */
import { formatClock, indexNetwork, prepareRouteTrips, type NetworkRoute, type NetworkStop, type PreparedTrip } from '@myciti/shared';
import { loadConfig } from '../src/config';
import { parseTimetablePage } from '../src/parser/timetable';
import { routeTimetablePath } from '../src/poller';

const args = process.argv.slice(2);
const arg = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : def;
};
const server = arg('server', 'http://localhost:3000');
const routes = arg('routes', '101,T01,D01').split(',');
const cfg = loadConfig();

interface VehicleFeature {
  geometry: { coordinates: [number, number] };
  properties: {
    key: string;
    tripId: string;
    headsign: string;
    state: string;
    distAlong: number;
    delaySec: number;
    suspect: boolean;
    prevStop: { id: string; name: string };
    nextStop: { id: string; name: string };
    dataAgeSec: number;
  };
}

const net = (await (await fetch(`${server}/api/network`)).json()) as { routes: NetworkRoute[]; stops: NetworkStop[] };
const idx = indexNetwork(net.routes, net.stops);
let total = 0;
let failures = 0;

for (const routeId of routes) {
  const t0 = Date.now();
  const res = await fetch(cfg.baseUrl + routeTimetablePath(routeId), { headers: { 'user-agent': cfg.userAgent } });
  const html = await res.text();
  const pageAt = Math.round((t0 + Date.now()) / 2);
  const vehicles = (await (await fetch(`${server}/api/vehicles?routes=${encodeURIComponent(routeId)}`)).json()) as {
    serverTime: number;
    features: VehicleFeature[];
  };
  const liveTrips = (await (await fetch(`${server}/api/trips/live?routes=${encodeURIComponent(routeId)}`)).json()) as {
    trips: PreparedTrip[];
  };
  const now = vehicles.serverTime;
  const page = parseTimetablePage(html, routeId);
  const fresh = new Map(prepareRouteTrips(page.directions, { idx, fetchedAt: pageAt }).map((t) => [t.tripId, t]));
  const served = new Map(liveTrips.trips.map((t) => [t.tripId, t]));

  console.log(`\n=== route ${routeId}: page fetched ${formatClock(pageAt)} (HTTP ${res.status}), ${vehicles.features.length} bus(es) on the map at ${new Date(now).toISOString()}`);
  console.log('trip      state    between (page times)                                    now    delay  along  ok');
  for (const f of vehicles.features) {
    total++;
    const p = f.properties;
    const ft = fresh.get(p.tripId);
    const st = served.get(p.tripId);
    if (!ft || !st) {
      failures++;
      console.log(`${p.tripId.padEnd(9)} ${p.state.padEnd(8)} trip not found on the fresh page / server  FAIL`);
      continue;
    }
    const iPrev = st.stops.findIndex((s) => s.stopId === p.prevStop.id);
    const iNext = st.stops.findIndex((s, k) => k >= iPrev && s.stopId === p.nextStop.id);
    const a = ft.stops[iPrev];
    const b = ft.stops[iNext];
    if (!a || !b) {
      failures++;
      console.log(`${p.tripId.padEnd(9)} stops not found FAIL`);
      continue;
    }
    // minute precision: a stop "HH:MM" means somewhere in [HH:MM, HH:MM+1)
    let okTime: boolean;
    if (p.state === 'moving') okTime = a.raw <= now + 60_000 && now < b.raw + 60_000;
    else if (p.state === 'waiting') okTime = now <= a.raw + 60_000;
    else okTime = now >= a.raw - 60_000;
    // tolerate stamps the engine flagged as inconsistent (outliers)
    const outlier = st.stops[iPrev]!.outlier || st.stops[iNext]!.outlier;
    const sa = st.stops[iPrev]!;
    const sb = st.stops[iNext]!;
    const okPlace = p.distAlong >= sa.dist - 1 && p.distAlong <= sb.dist + 1;
    const ok = (okTime || outlier) && okPlace;
    if (!ok) failures++;
    const between =
      p.state === 'moving'
        ? `${a.stopId} ${formatClock(a.raw)} -> ${b.stopId} ${formatClock(b.raw)}`
        : `${p.state} at ${a.stopId} ${formatClock(a.raw)}`;
    console.log(
      `${p.tripId.padEnd(9)} ${p.state.padEnd(8)} ${between.padEnd(55)} ${formatClock(now)}  ${String(Math.round(p.delaySec / 60)).padStart(4)}m ${String(Math.round(p.distAlong)).padStart(6)}  ${ok ? 'OK' : 'FAIL'}${outlier ? ' (outlier stamp)' : ''}${p.suspect ? ' [suspect]' : ''}`,
    );
  }
  await new Promise((r) => setTimeout(r, 2000));
}

console.log(`\n${total - failures}/${total} buses consistent with the route pages`);
process.exit(failures ? 1 : 0);

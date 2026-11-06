import { readFileSync } from 'node:fs';
import {
  estimateAll,
  estimateVehicle,
  indexNetwork,
  matchStopsToShape,
  prepareRouteTrips,
  stopDistanceM,
  type PreparedTrip,
} from '@myciti/shared';
import { describe, expect, it } from 'vitest';
import { parseNetworkPage } from '../src/parser/network';
import { parseTimetablePage } from '../src/parser/timetable';

const fixture = (name: string) => readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), 'utf8');
const sast = (iso: string) => Date.parse(`${iso}+02:00`);

const net = parseNetworkPage(fixture('network-map.html'), sast('2026-11-06T15:16:13'));
const idx = indexNetwork(net.routes, net.stops);
const FETCHED: Record<string, number> = {
  '101': sast('2026-11-06T15:16:35'),
  T01: sast('2026-11-06T15:16:51'),
  D01: sast('2026-11-06T15:16:57'),
};
const prepared: Record<string, PreparedTrip[]> = {};
for (const [route, at] of Object.entries(FETCHED)) {
  const page = parseTimetablePage(fixture(`route-${route}.html`), route);
  prepared[route] = prepareRouteTrips(page.directions, { idx, fetchedAt: at, matchCache: new Map() });
}
const trip = (route: string, id: string) => prepared[route]!.find((t) => t.tripId === id)!;
const ids = (t: PreparedTrip, i: number, j: number) => [t.stops[i]!.stopId, t.stops[j]!.stopId];

describe('prepared trips from fixtures', () => {
  it('keeps every stop, restores travel order and is monotone in time and distance', () => {
    for (const [route, trips] of Object.entries(prepared)) {
      expect(trips.length).toBeGreaterThan(0);
      for (const t of trips) {
        const seq = idx.directions.get(`${route}:${t.directionId}`)!.stopIds;
        // travel order is a subsequence of the published direction sequence
        let pos = -1;
        for (const s of t.stops) {
          const next = seq.indexOf(s.stopId, pos + 1);
          expect(next, `${t.key} ${s.stopId}`).toBeGreaterThan(pos);
          pos = next;
        }
        for (let k = 1; k < t.stops.length; k++) {
          expect(t.stops[k]!.fit).toBeGreaterThanOrEqual(t.stops[k - 1]!.fit);
          expect(t.stops[k]!.dist).toBeGreaterThanOrEqual(t.stops[k - 1]!.dist);
          expect(t.stops[k]!.sched).toBeGreaterThanOrEqual(t.stops[k - 1]!.sched);
        }
      }
    }
  });

  it('matches stops onto the route traces closely', () => {
    const offsets: number[] = [];
    for (const r of net.routes) {
      for (const d of r.directions) {
        const shape = idx.shapes.get(`${r.id}:${d.directionId}`)!;
        const pts = d.stopIds.map((id) => idx.stops.get(id)!).map((s) => [s.lng, s.lat] as [number, number]);
        const m = matchStopsToShape(shape, pts);
        offsets.push(...m.map((x) => x.offset));
        for (let k = 1; k < m.length; k++) expect(m[k]!.dist).toBeGreaterThanOrEqual(m[k - 1]!.dist);
      }
    }
    // The published trace of 237/0 misses five stops by 350-414 m (data quirk on the site);
    // everything else is within ~170 m.
    const far = offsets.filter((o) => o > 150).length;
    expect(far / offsets.length).toBeLessThan(0.01);
    expect(Math.max(...offsets)).toBeLessThan(500);
  });

  it('101/68740: published order is by live time; outliers re-estimated', () => {
    const t = trip('101', '68740');
    expect(t.stops.map((s) => s.stopId).join(' ')).toBe(
      'WXFRD STJMS GRDNA NZRTH GRDNS ANDAL GOVERN MICHAEL UPLOP LEUWN CHRCH MDLOP RIEBK ADLEY CIVIC',
    );
    expect(t.stops.filter((s) => s.outlier).map((s) => s.stopId)).toEqual(['UPLOP', 'LEUWN', 'RIEBK']);
    expect(t.suspect).toBe(false);
    const e = estimateVehicle(t, FETCHED['101']!)!;
    expect(e.state).toBe('moving');
    expect(ids(t, e.prevIdx, e.nextIdx)).toEqual(['GRDNS', 'ANDAL']);
  });

  it('D01/106900: premature stamp at LNDLA is re-estimated with the trip delay', () => {
    const t = trip('D01', '106900');
    expect(t.stops.filter((s) => s.outlier).map((s) => s.stopId)).toEqual(['LNDLA']);
    const lndla = t.stops[1]!;
    expect(lndla.fit - lndla.sched).toBe(20 * 60_000);
    const e = estimateVehicle(t, FETCHED.D01!)!;
    expect(ids(t, e.prevIdx, e.nextIdx)).toEqual(['KUYASA', 'LNDLA']);
  });

  it('flags the one-trip-shift pattern (101 morning, T01 74618, D01 +2.5h) as suspect', () => {
    for (const id of ['68723', '68725', '68727', '68724', '68726', '68728']) expect(trip('101', id).suspect, id).toBe(true);
    for (const id of ['68731', '68733', '68735', '68737', '68739', '68740']) expect(trip('101', id).suspect, id).toBe(false);
    expect(trip('T01', '74618').suspect).toBe(true);
    expect(trip('D01', '106862').suspect).toBe(true);
    expect(trip('D01', '106900').suspect).toBe(false);
  });

  it('every bus is between the stops whose times bracket "now" (acceptance check)', () => {
    for (const [route, at] of Object.entries(FETCHED)) {
      const vehicles = estimateAll(prepared[route]!, at, (a, b) => stopDistanceM(idx, a, b));
      expect(vehicles.length, route).toBeGreaterThan(0);
      for (const { trip: t, est } of vehicles) {
        const a = t.stops[est.prevIdx]!;
        const b = t.stops[est.nextIdx]!;
        if (est.state === 'moving') {
          expect(a.fit).toBeLessThanOrEqual(at);
          expect(b.fit).toBeGreaterThan(at);
          expect(est.dist).toBeGreaterThanOrEqual(a.dist);
          expect(est.dist).toBeLessThanOrEqual(b.dist);
          // the published (unfitted) times bracket "now" too unless one of them was an outlier
          if (!a.outlier && !b.outlier) {
            expect(a.raw, t.key).toBeLessThanOrEqual(at);
            expect(b.raw + 60_000, t.key).toBeGreaterThan(at); // minute precision
          }
        }
      }
    }
  });

  it('T01 at 15:16:00: buses that finished at a terminal and restarted are shown once', () => {
    // 74515 arrived at STBLS 15:15 and 74516 left STBLS 15:15; 74567 arrived at WFRONT 15:15
    // and 76687 left WFRONT 15:15. (At the fetch time 15:16:51 the arrivals are > 1 min old.)
    const at = sast('2026-11-06T15:16:00');
    const all = prepared.T01!.map((t) => estimateVehicle(t, at)).filter(Boolean);
    const merged = estimateAll(prepared.T01!, at, (a, b) => stopDistanceM(idx, a, b));
    const mergedPairs = merged.filter((v) => v.mergedFrom).map((v) => `${v.mergedFrom}->${v.trip.key}`);
    expect(mergedPairs.sort()).toEqual(['T01:74515->T01:74516', 'T01:74567->T01:76687']);
    expect(merged.length).toBe(all.length - 2);
  });
});

import { describe, expect, it } from 'vitest';
import { estimateAll, estimateVehicle } from '../src/position';
import { indexNetwork, orderTripStops, prepareRouteTrips, stopDistanceM } from '../src/trip';
import type { LngLat, NetworkRoute, NetworkStop, PreparedTrip, RawDirectionTimetable, RawStopTime } from '../src/types';

const sast = (iso: string) => Date.parse(`${iso}+02:00`);
const MIN = 60_000;

// A synthetic north-south route: stops every ~555 m, shape slightly offset (as on real roads).
const LAT = -33.9;
const LNG = 18.4;
const pt = (dy: number): LngLat => [LNG, LAT + dy * 0.001];
const stops: NetworkStop[] = [
  { id: 'A', name: 'Alpha', lat: LAT, lng: LNG, routes: ['X1'] },
  { id: 'B', name: 'Bravo', lat: LAT + 0.005, lng: LNG + 0.0001, routes: ['X1'] },
  { id: 'C', name: 'Charlie', lat: LAT + 0.01, lng: LNG, routes: ['X1'] },
  { id: 'D', name: 'Delta', lat: LAT + 0.015, lng: LNG - 0.0001, routes: ['X1'] },
];
const route: NetworkRoute = {
  id: 'X1',
  name: 'X1',
  longName: 'Alpha - Delta',
  color: '#FF0000',
  textColor: '#FFFFFF',
  directions: [
    { directionId: 0, headsign: 'X1 Delta', stopIds: ['A', 'B', 'C', 'D'], shape: [pt(0), pt(5), pt(10), pt(15)] },
    { directionId: 1, headsign: 'X1 Alpha', stopIds: ['D', 'C', 'B', 'A'], shape: [pt(15), pt(10), pt(5), pt(0)] },
  ],
};
const idx = indexNetwork([route], stops);
const LEG = idx.shapes.get('X1:0')!.length / 3; // ~555 m

type S = [id: string, staticTime: string, time: string, live?: boolean];
const st = ([id, staticTime, time, live = true]: S): RawStopTime => ({
  stopId: id,
  name: id,
  isStation: false,
  staticTime,
  time,
  live,
});

function tt(directionId: number, trips: { id: string; stops: S[] }[], day = 'Friday'): RawDirectionTimetable {
  return {
    routeId: 'X1',
    directionId,
    routeName: 'Alpha - Delta',
    day,
    serviceAdvisory: null,
    trips: trips.map((t) => ({
      tripId: t.id,
      startTime: t.stops[0]![2],
      // the site lists stops sorted by live time - emulate that
      stops: t.stops.map(st).sort((a, b) => a.time.localeCompare(b.time)),
    })),
  };
}

function prep(tts: RawDirectionTimetable[], fetchedAt: number): Map<string, PreparedTrip> {
  const trips = prepareRouteTrips(tts, { idx, fetchedAt });
  return new Map(trips.map((t) => [t.tripId, t]));
}

const FETCH = sast('2026-11-06T10:00:30');

describe('orderTripStops', () => {
  it('restores travel order from a list sorted by live time', () => {
    const list = [st(['C', '10:10', '10:08']), st(['A', '10:00', '10:00']), st(['B', '10:05', '10:09'])].sort((a, b) =>
      a.time.localeCompare(b.time),
    );
    expect(list.map((s) => s.stopId)).toEqual(['A', 'C', 'B']);
    const { ordered } = orderTripStops(list, ['A', 'B', 'C', 'D']);
    expect(ordered.map((o) => o.raw.stopId)).toEqual(['A', 'B', 'C']);
  });

  it('uses the published sequence for equal scheduled minutes', () => {
    const list = [st(['C', '10:05', '10:05']), st(['B', '10:05', '10:05']), st(['A', '10:00', '10:00'])];
    const { ordered } = orderTripStops(list, ['A', 'B', 'C']);
    expect(ordered.map((o) => o.raw.stopId)).toEqual(['A', 'B', 'C']);
  });

  it('orders a trip across midnight', () => {
    const list = [st(['C', '00:05', '00:07']), st(['A', '23:50', '23:52']), st(['B', '23:58', '00:01'])];
    const { startClock, ordered } = orderTripStops(list, ['A', 'B', 'C']);
    expect(startClock).toBe(23 * 60 + 50);
    expect(ordered.map((o) => [o.raw.stopId, o.schedOff, o.rawOff])).toEqual([
      ['A', 0, 2],
      ['B', 8, 11],
      ['C', 15, 17],
    ]);
  });
});

describe('estimateVehicle', () => {
  const trips = prep(
    [
      tt(0, [
        { id: 'T1', stops: [['A', '10:00', '10:00'], ['B', '10:04', '10:04'], ['C', '10:08', '10:08'], ['D', '10:12', '10:12']] },
        { id: 'NOTLIVE', stops: [['A', '10:00', '10:00', false], ['B', '10:04', '10:04', false], ['C', '10:08', '10:08', false]] },
      ]),
    ],
    FETCH,
  );
  const t1 = trips.get('T1')!;

  it('hides a bus once its snapshot is older than maxDataAgeMs', () => {
    const now = sast('2026-11-06T10:02:00');
    const stale = { ...t1, fetchedAt: now - 21 * MIN };
    expect(estimateVehicle(stale, now)).toBeNull();
    expect(estimateVehicle(stale, now, { maxDataAgeMs: 0 })).not.toBeNull();
    expect(estimateVehicle({ ...t1, fetchedAt: now - 19 * MIN }, now)).not.toBeNull();
  });

  it('interpolates between the bracketing stops along the shape', () => {
    const e = estimateVehicle(t1, sast('2026-11-06T10:02:00'))!;
    expect(e.state).toBe('moving');
    expect(e.prevIdx).toBe(0);
    expect(e.nextIdx).toBe(1);
    expect(e.dist).toBeCloseTo(LEG / 2, -1);
    const e2 = estimateVehicle(t1, sast('2026-11-06T10:09:00'))!;
    expect([e2.prevIdx, e2.nextIdx]).toEqual([2, 3]);
    expect(e2.dist).toBeCloseTo(2.25 * LEG, -1);
  });

  it('waits at the first stop up to 5 minutes before departure', () => {
    expect(estimateVehicle(t1, sast('2026-11-06T09:54:59'))).toBeNull();
    const e = estimateVehicle(t1, sast('2026-11-06T09:56:00'))!;
    expect(e.state).toBe('waiting');
    expect(e.dist).toBe(0);
  });

  it('shows the bus at the last stop for 1 minute, then hides it', () => {
    const e = estimateVehicle(t1, sast('2026-11-06T10:12:30'))!;
    expect(e.state).toBe('arrived');
    expect(e.dist).toBeCloseTo(3 * LEG, -1);
    expect(estimateVehicle(t1, sast('2026-11-06T10:13:01'))).toBeNull();
  });

  it('ignores trips without live data', () => {
    expect(estimateVehicle(trips.get('NOTLIVE')!, sast('2026-11-06T10:02:00'))).toBeNull();
  });

  it('positions by live time, not by schedule', () => {
    const late = prep(
      [tt(0, [{ id: 'L', stops: [['A', '10:00', '10:10'], ['B', '10:04', '10:14'], ['C', '10:08', '10:18']] }])],
      FETCH,
    ).get('L')!;
    const e = estimateVehicle(late, sast('2026-11-06T10:12:00'))!;
    expect([e.prevIdx, e.nextIdx]).toEqual([0, 1]);
    expect(e.delaySec).toBe(600);
    expect(late.suspect).toBe(false);
  });

  it('spreads stops that share the same minute', () => {
    const tie = prep(
      [tt(0, [{ id: 'TIE', stops: [['A', '10:00', '10:00'], ['B', '10:01', '10:01'], ['C', '10:01', '10:01'], ['D', '10:02', '10:02']] }])],
      FETCH,
    ).get('TIE')!;
    const fits = tie.stops.map((s) => s.fit - sast('2026-11-06T10:00:00'));
    expect(fits[0]).toBe(0);
    expect(fits[1]).toBe(MIN);
    expect(fits[2]!).toBeGreaterThan(MIN);
    expect(fits[2]!).toBeLessThan(2 * MIN);
    expect(fits[3]).toBe(2 * MIN);
    // the bus keeps moving through B..C instead of jumping
    const e = estimateVehicle(tie, sast('2026-11-06T10:01:15'))!;
    expect(e.dist).toBeGreaterThan(tie.stops[1]!.dist);
    expect(e.dist).toBeLessThan(tie.stops[2]!.dist);
  });
});

describe('suspect trips', () => {
  it('marks trips deviating more than 30 minutes but still positions them by time', () => {
    const trips = prep(
      [
        tt(0, [
          // shifted by one trip (~60 min early), as seen on route 101 on the morning of 2026-11-06
          { id: 'SHIFT', stops: [['A', '10:50', '09:50'], ['B', '10:54', '09:54'], ['C', '10:58', '09:58']] },
          { id: 'OK', stops: [['A', '09:50', '09:52'], ['B', '09:54', '09:56'], ['C', '09:58', '10:00']] },
        ]),
      ],
      FETCH,
    );
    const shift = trips.get('SHIFT')!;
    expect(shift.suspect).toBe(true);
    expect(shift.maxAbsDelayMin).toBe(60);
    expect(trips.get('OK')!.suspect).toBe(false);
    const e = estimateVehicle(shift, sast('2026-11-06T09:52:00'))!;
    expect([e.prevIdx, e.nextIdx]).toEqual([0, 1]);
    expect(e.delaySec).toBe(-3600);
  });
});

describe('trips across midnight', () => {
  const night = [
    tt(0, [
      { id: 'EARLY', stops: [['A', '04:50', '04:50'], ['B', '04:55', '04:55']] },
      { id: 'LATE', stops: [['A', '23:50', '23:53'], ['B', '23:58', '00:02'], ['C', '00:05', '00:09'], ['D', '00:12', '00:15']] },
      { id: 'AFTER', stops: [['A', '00:20', '00:21'], ['B', '00:25', '00:26']] },
    ]),
  ];

  it('places post-midnight times on the next calendar day', () => {
    const trips = prep(night, sast('2026-11-06T23:55:00'));
    const late = trips.get('LATE')!;
    expect(late.stops.map((s) => s.stopId)).toEqual(['A', 'B', 'C', 'D']);
    expect(late.stops[0]!.sched).toBe(sast('2026-11-06T23:50:00'));
    expect(late.stops[1]!.raw).toBe(sast('2026-11-07T00:02:00'));
    expect(late.stops[3]!.sched).toBe(sast('2026-11-07T00:12:00'));
    // a trip that starts after midnight belongs to the same service day
    expect(trips.get('AFTER')!.stops[0]!.sched).toBe(sast('2026-11-07T00:20:00'));
    expect(trips.get('EARLY')!.stops[0]!.sched).toBe(sast('2026-11-06T04:50:00'));
  });

  it('positions a bus across midnight, fetched before or after it', () => {
    for (const fetchedAt of [sast('2026-11-06T23:55:00'), sast('2026-11-07T00:05:00')]) {
      const late = prep(night, fetchedAt).get('LATE')!;
      const e = estimateVehicle(late, sast('2026-11-07T00:04:00'))!;
      expect(e.state).toBe('moving');
      expect([late.stops[e.prevIdx]!.stopId, late.stops[e.nextIdx]!.stopId]).toEqual(['B', 'C']);
      expect(e.delaySec).toBeGreaterThan(0);
    }
  });
});

describe('terminal de-duplication', () => {
  const dist = (a: string, b: string) => stopDistanceM(idx, a, b);

  it('shows one marker when a bus ends one trip and starts the next at the same terminal', () => {
    const trips = prep(
      [
        tt(0, [{ id: 'IN', stops: [['A', '09:40', '09:40'], ['B', '09:44', '09:44'], ['C', '09:48', '09:48'], ['D', '10:00', '10:00']] }]),
        tt(1, [{ id: 'OUT', stops: [['D', '10:03', '10:03'], ['C', '10:07', '10:07'], ['B', '10:11', '10:11']] }]),
      ],
      FETCH,
    );
    const now = sast('2026-11-06T10:00:30');
    const all = [...trips.values()];
    expect(all.map((t) => estimateVehicle(t, now)?.state)).toEqual(['arrived', 'waiting']);
    const v = estimateAll(all, now, dist);
    expect(v).toHaveLength(1);
    expect(v[0]!.trip.tripId).toBe('OUT');
    expect(v[0]!.mergedFrom).toBe('X1:IN');
  });

  it('keeps both if the next trip leaves from elsewhere or much later', () => {
    const trips = prep(
      [
        tt(0, [{ id: 'IN', stops: [['A', '09:40', '09:40'], ['D', '10:00', '10:00']] }]),
        tt(1, [
          { id: 'ELSEWHERE', stops: [['C', '10:02', '10:02'], ['B', '10:06', '10:06']] },
          { id: 'LATER', stops: [['D', '10:04', '10:04'], ['A', '10:30', '10:30']] },
        ]),
      ],
      FETCH,
    );
    // at 10:00:30 IN has arrived at D, ELSEWHERE waits at C, LATER waits at D (gap 4 min)
    const now = sast('2026-11-06T10:00:30');
    const v = estimateAll([...trips.values()], now, dist, { terminalMergeMaxGapMs: 3 * MIN });
    expect(v.map((x) => x.trip.tripId).sort()).toEqual(['ELSEWHERE', 'IN', 'LATER']);
  });
});

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { indexNetwork, prepareRouteTrips, type PreparedTrip } from '@myciti/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { csvLine, punctualityRows, reconstructDay, stopTimeRows } from '../src/observation-report';
import { parseNetworkPage } from '../src/parser/network';
import { parseTimetablePage } from '../src/parser/timetable';
import {
  ObservationLog,
  ObservationState,
  listLogFiles,
  parseLogLine,
  readLogFile,
  snapshotServiceDate,
  type LogRecord,
  type ObsRecord,
} from '../src/stores/observation-log';

const TZ = 'Africa/Johannesburg';
const fixture = (name: string) => readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), 'utf8');
const sast = (iso: string) => Date.parse(`${iso}+02:00`);

const net = parseNetworkPage(fixture('network-map.html'), sast('2026-11-06T15:16:13'));
const idx = indexNetwork(net.routes, net.stops);
const page101 = parseTimetablePage(fixture('route-101.html'), '101');
const FETCHED = sast('2026-11-06T15:16:35');
const trips101 = prepareRouteTrips(page101.directions, { idx, fetchedAt: FETCHED, matchCache: new Map() });

const obsOf = (recs: LogRecord[]) => recs.filter((r): r is ObsRecord => r.k === 'obs');

describe('snapshotServiceDate', () => {
  it('uses the page weekday and the engine\'s service-day rules', () => {
    expect(snapshotServiceDate(page101.directions, FETCHED, TZ)).toBe('2026-11-06');
    // Friday's page fetched after midnight is still Friday's service date
    expect(snapshotServiceDate(page101.directions, sast('2026-11-07T00:30:00'), TZ)).toBe('2026-11-06');
  });
});

describe('ObservationState.diff', () => {
  it('logs every trip once, and only stops that carry information', () => {
    const st = new ObservationState();
    const recs = st.diff('101', '2026-11-06', 'Friday', trips101, FETCHED);
    expect(recs[0]).toMatchObject({ k: 'poll', r: '101', sd: '2026-11-06', trips: trips101.length, live: 20 });
    expect(recs.filter((r) => r.k === 'trip')).toHaveLength(trips101.length);
    const obs = obsOf(recs);
    const informative = trips101.flatMap((t) => t.stops.filter((s) => s.live || s.raw !== s.sched));
    expect(obs).toHaveLength(informative.length);
    expect(obs.length).toBeGreaterThan(200);
    for (const o of obs) {
      const trip = trips101.find((t) => t.tripId === o.trip)!;
      const s = trip.stops[o.seq]!;
      expect(o.stop).toBe(s.stopId);
      expect(o.sched).toBe(Math.round(s.sched / 1000));
      expect(o.time).toBe(Math.round(s.raw / 1000));
      expect(o.live).toBe(s.live ? 1 : 0);
    }
    expect((recs[0] as { changed: number }).changed).toBe(obs.length);
  });

  it('logs nothing but the poll when nothing changed, and one record per changed stop', () => {
    const st = new ObservationState();
    st.diff('101', '2026-11-06', 'Friday', trips101, FETCHED);
    const again = st.diff('101', '2026-11-06', 'Friday', trips101, FETCHED + 60_000);
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ k: 'poll', changed: 0 });

    const live = trips101.find((t) => t.live)!;
    const changed: PreparedTrip[] = trips101.map((t) =>
      t === live ? { ...t, stops: t.stops.map((s, i) => (i === 3 ? { ...s, raw: s.raw + 120_000 } : s)) } : t,
    );
    const third = st.diff('101', '2026-11-06', 'Friday', changed, FETCHED + 120_000);
    expect(third).toHaveLength(2);
    expect(third[1]).toMatchObject({ k: 'obs', trip: live.tripId, seq: 3, time: Math.round((live.stops[3]!.raw + 120_000) / 1000) });
  });

  it('logs a schedule-only stop once it is first published off schedule, and when it goes live', () => {
    const st = new ObservationState();
    const t = trips101.find((x) => !x.live)!;
    st.diff('101', '2026-11-06', 'Friday', [t], FETCHED);
    const shifted = { ...t, stops: t.stops.map((s, i) => (i === 0 ? { ...s, raw: s.raw + 60_000 } : s)) };
    const r1 = obsOf(st.diff('101', '2026-11-06', 'Friday', [shifted], FETCHED + 60_000));
    expect(r1).toHaveLength(1);
    expect(r1[0]).toMatchObject({ seq: 0, live: 0 });
    const live = { ...shifted, live: true, stops: shifted.stops.map((s, i) => (i === 0 ? { ...s, live: true } : s)) };
    const r2 = obsOf(st.diff('101', '2026-11-06', 'Friday', [live], FETCHED + 120_000));
    expect(r2).toHaveLength(1);
    expect(r2[0]).toMatchObject({ seq: 0, live: 1 });
  });

  it('starts afresh on a new service date', () => {
    const st = new ObservationState();
    st.diff('101', '2026-11-06', 'Friday', trips101, FETCHED);
    const next = st.diff('101', '2026-11-07', 'Saturday', trips101, FETCHED + 86_400_000);
    expect(next.filter((r) => r.k === 'trip')).toHaveLength(trips101.length);
  });

  it('replay rebuilds the state so nothing is logged twice', () => {
    const a = new ObservationState();
    const recs = a.diff('101', '2026-11-06', 'Friday', trips101, FETCHED);
    const b = new ObservationState();
    for (const r of recs) b.replay('2026-11-06', r);
    const again = b.diff('101', '2026-11-06', 'Friday', trips101, FETCHED + 60_000);
    expect(again).toHaveLength(1);
  });
});

describe('parseLogLine', () => {
  it('ignores blank and broken lines', () => {
    expect(parseLogLine('')).toBeNull();
    expect(parseLogLine('{"k":"nope"}')).toBeNull();
    expect(parseLogLine('{"k":"poll","t":1,"r":"101"')).toBeNull();
    expect(parseLogLine('{"k":"poll","t":1,"r":"101","day":"Friday","sd":"2026-11-06","trips":1,"live":1,"changed":0}')).toMatchObject({ k: 'poll' });
  });
});

describe('ObservationLog files', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'myciti-obs-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('appends one file per service date, replays it on restart and reports status', async () => {
    let now = FETCHED;
    const log = new ObservationLog({ dir, tz: TZ, keepDays: 0, now: () => now });
    await log.init();
    const first = log.record('101', page101.directions, trips101, FETCHED);
    now += 60_000;
    log.record('101', page101.directions, trips101, FETCHED + 60_000);
    await log.flush();
    expect(await readdir(dir)).toEqual(['2026-11-06.jsonl']);
    const lines = (await readFile(join(dir, '2026-11-06.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(first.length + 1);
    const status = await log.status();
    expect(status).toMatchObject({ enabled: true, recordsWritten: first.length + 1, files: 1, openDates: ['2026-11-06'], lastError: null });
    expect(status.bytesOnDisk).toBeGreaterThan(0);

    // restart: the replayed state knows every value, so only the poll record is appended
    const log2 = new ObservationLog({ dir, tz: TZ, keepDays: 0, now: () => now });
    expect(await log2.init()).toBe(first.length + 1);
    const after = log2.record('101', page101.directions, trips101, FETCHED + 120_000);
    expect(after).toHaveLength(1);
    await log2.flush();
    const read: LogRecord[] = [];
    for await (const r of readLogFile(join(dir, '2026-11-06.jsonl'))) read.push(r);
    expect(read).toHaveLength(first.length + 2);
  });

  it('compresses finished days, keeps the current ones, and applies retention', async () => {
    let now = sast('2026-11-08T10:00:00');
    const write = (date: string) => writeFile(join(dir, `${date}.jsonl`), '{"k":"poll","t":1,"r":"101","day":"x","sd":"' + date + '","trips":0,"live":0,"changed":0}\n');
    await write('2026-11-05');
    await write('2026-11-06');
    await write('2026-11-07');
    await write('2026-11-08');
    const log = new ObservationLog({ dir, tz: TZ, keepDays: 0, now: () => now });
    await log.init(); // runs maintenance
    expect((await readdir(dir)).sort()).toEqual(['2026-11-05.jsonl.gz', '2026-11-06.jsonl.gz', '2026-11-07.jsonl', '2026-11-08.jsonl']);
    const gz = gunzipSync(await readFile(join(dir, '2026-11-06.jsonl.gz'))).toString();
    expect(parseLogLine(gz.trim())).toMatchObject({ k: 'poll', sd: '2026-11-06' });
    const files = await listLogFiles(dir);
    expect(files.map(([d]) => d)).toEqual(['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']);
    const back: LogRecord[] = [];
    for await (const r of readLogFile(files[0]![1])) back.push(r);
    expect(back).toHaveLength(1);

    // a day just written to is left alone even if it is old enough
    const late = log.record('101', page101.directions, trips101, sast('2026-11-06T15:16:35'));
    await log.flush();
    await log.maintain();
    expect((await readdir(dir)).sort()).toContain('2026-11-06.jsonl');

    // an hour later it is appended to the existing compressed file as a second gzip member
    now += 3_600_000;
    await log.maintain();
    expect((await readdir(dir)).filter((f) => f.startsWith('2026-11-06'))).toEqual(['2026-11-06.jsonl.gz']);
    const merged: LogRecord[] = [];
    for await (const r of readLogFile(join(dir, '2026-11-06.jsonl.gz'))) merged.push(r);
    expect(merged).toHaveLength(1 + late.length);

    // retention: keep 2 days
    now = sast('2026-11-10T10:00:00');
    const short = new ObservationLog({ dir, tz: TZ, keepDays: 2, now: () => now });
    await short.init();
    expect((await readdir(dir)).sort()).toEqual(['2026-11-08.jsonl.gz']);
  });

  it('survives a broken line when replaying', async () => {
    await writeFile(join(dir, '2026-11-06.jsonl'), 'garbage\n{"k":"trip","t":1,"r":"101","d":0,"trip":"x","stops":[["A",1]]}\n');
    const log = new ObservationLog({ dir, tz: TZ, keepDays: 0, now: () => FETCHED });
    expect(await log.init()).toBe(1);
  });
});

describe('reconstruction and reports', () => {
  const t0 = Math.round(sast('2026-11-06T08:00:00') / 1000);
  const records: LogRecord[] = [
    { k: 'poll', t: t0, r: 'X', day: 'Friday', sd: '2026-11-06', trips: 2, live: 1, changed: 0 },
    { k: 'trip', t: t0, r: 'X', d: 0, trip: 'a', stops: [['S1', t0], ['S2', t0 + 600], ['S3', t0 + 1200]] },
    { k: 'trip', t: t0, r: 'X', d: 0, trip: 'b', stops: [['S1', t0 + 3600], ['S2', t0 + 4200], ['S3', t0 + 4800]] },
    // trip a: departs 2 min late, prediction for S3 revised, finally arrives 4 min late
    { k: 'obs', t: t0 + 60, r: 'X', d: 0, trip: 'a', seq: 0, stop: 'S1', sched: t0, time: t0 + 120, live: 1 },
    { k: 'obs', t: t0 + 60, r: 'X', d: 0, trip: 'a', seq: 2, stop: 'S3', sched: t0 + 1200, time: t0 + 1320, live: 1 },
    { k: 'obs', t: t0 + 700, r: 'X', d: 0, trip: 'a', seq: 1, stop: 'S2', sched: t0 + 600, time: t0 + 780, live: 1 },
    { k: 'obs', t: t0 + 1500, r: 'X', d: 0, trip: 'a', seq: 2, stop: 'S3', sched: t0 + 1200, time: t0 + 1440, live: 1 },
  ];

  it('rebuilds trips with their final actual times', () => {
    const day = reconstructDay('2026-11-06', records);
    expect(day.polls).toBe(1);
    expect(day.trips.size).toBe(2);
    const rows = stopTimeRows(day);
    expect(rows).toHaveLength(6);
    const a3 = rows.find((r) => r.tripId === 'a' && r.seq === 2)!;
    expect(a3).toMatchObject({ actual: t0 + 1440, delayMin: 4, revisions: 2, firstLiveAt: t0 + 60, lastChangeAt: t0 + 1500, tracked: true });
    const b1 = rows.find((r) => r.tripId === 'b' && r.seq === 0)!;
    expect(b1).toMatchObject({ actual: null, delayMin: null, revisions: 0, tracked: false });
  });

  it('copes with observations that precede (or lack) their trip record', () => {
    const [poll, tripA, , ...obs] = records;
    const day = reconstructDay('2026-11-06', [poll!, ...obs, tripA!]);
    const rows = stopTimeRows(day);
    expect(rows.filter((r) => r.tripId === 'a')).toHaveLength(3);
    expect(rows.find((r) => r.tripId === 'a' && r.seq === 2)!.actual).toBe(t0 + 1440);
    const orphan = reconstructDay('2026-11-06', obs);
    expect(stopTimeRows(orphan).find((r) => r.seq === 1)).toMatchObject({ stopId: 'S2', sched: t0 + 600, actual: t0 + 780 });
  });

  it('aggregates punctuality per route, direction and hour', () => {
    const rows = stopTimeRows(reconstructDay('2026-11-06', records));
    const p = punctualityRows(rows, TZ);
    const all = p.find((r) => r.hour === -1)!;
    expect(all).toMatchObject({ routeId: 'X', tripsScheduled: 2, tripsTracked: 1, tripsComplete: 1, departureDelayMedian: 2, arrivalDelayMedian: 4, onTimeShare: 1 });
    expect(all.runTimeRatioMedian).toBeCloseTo((1440 - 120) / 1200, 3);
    expect(p.find((r) => r.hour === 8)).toMatchObject({ tripsScheduled: 1, tripsTracked: 1 });
    expect(p.find((r) => r.hour === 9)).toMatchObject({ tripsScheduled: 1, tripsTracked: 0, arrivalDelayMedian: null });
  });

  it('writes CSV safely', () => {
    expect(csvLine(['a', 1, null, true, 'x,y', 'q"r'])).toBe('a,1,,1,"x,y","q""r"');
  });
});

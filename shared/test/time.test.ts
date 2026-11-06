import { describe, expect, it } from 'vitest';
import {
  addDays,
  circularStart,
  formatClock,
  localMidnight,
  parseClock,
  resolveServiceDate,
  tzOffsetMs,
  serviceDayStartFrom,
  unwrapFrom,
  weekdayOf,
  wrapMinutes,
} from '../src/time';

// 2026-11-06 is a Friday. SAST = UTC+2, no DST.
const sast = (iso: string) => Date.parse(`${iso}+02:00`);

describe('clock parsing', () => {
  it('parses HH:MM', () => {
    expect(parseClock('05:36')).toBe(336);
    expect(parseClock('0:05')).toBe(5);
    expect(parseClock('24:10')).toBe(1450);
    expect(parseClock('23:59:30')).toBe(1439);
    expect(parseClock('')).toBeNull();
    expect(parseClock('5.36')).toBeNull();
    expect(parseClock('12:61')).toBeNull();
  });

  it('wraps minute differences into [-720, 720)', () => {
    expect(wrapMinutes(5)).toBe(5);
    expect(wrapMinutes(-20)).toBe(-20);
    expect(wrapMinutes(0 - 1430)).toBe(10); // 00:00 vs 23:50 -> +10
    expect(wrapMinutes(1435 - 5)).toBe(-10); // 23:55 vs 00:05 -> -10
  });

  it('finds where a circular sequence starts', () => {
    expect(circularStart([600, 620, 640])).toBe(600);
    expect(circularStart([1430, 1435, 5, 20])).toBe(1430); // trip across midnight
    expect(circularStart([290, 300, 400, 600, 800, 1000, 1200, 1380, 10])).toBe(290); // 04:50 .. 00:10
    expect(unwrapFrom(5, 1430)).toBe(1445);
    expect(unwrapFrom(1435, 1430)).toBe(1435);
  });
});

describe('serviceDayStartFrom', () => {
  it('uses the night gap around 03:00', () => {
    expect(serviceDayStartFrom([290, 1430, 20])).toBe(290); // few trips: 04:50, 23:50, 00:20
    expect(serviceDayStartFrom([360, 420, 960, 1020])).toBe(360); // peak-only route
    expect(serviceDayStartFrom([1020, 1380, 15])).toBe(1020); // evening-only route
    expect(serviceDayStartFrom([170, 200, 600])).toBe(170); // 24h-ish service: gap 10:00..02:50
  });
});

describe('time zone helpers', () => {
  it('Africa/Johannesburg is UTC+2', () => {
    expect(tzOffsetMs(sast('2026-11-06T15:16:00'))).toBe(2 * 3_600_000);
    expect(localMidnight(sast('2026-11-06T15:16:00'))).toBe(sast('2026-11-06T00:00:00'));
    expect(localMidnight(sast('2026-11-06T00:30:00'))).toBe(sast('2026-11-06T00:00:00'));
    expect(addDays(sast('2026-11-06T00:00:00'), 1)).toBe(sast('2026-11-07T00:00:00'));
    expect(weekdayOf(sast('2026-11-06T12:00:00'))).toBe('Friday');
    expect(formatClock(sast('2026-11-06T07:05:00'))).toBe('07:05');
  });

  it('resolves the service date from the weekday name', () => {
    const fri = sast('2026-11-06T00:00:00');
    expect(resolveServiceDate('Friday', sast('2026-11-06T15:16:00'), 290)).toBe(fri);
    // page still shows Friday's service just after midnight
    expect(resolveServiceDate('Friday', sast('2026-11-07T00:30:00'), 290)).toBe(fri);
    // page already shows Saturday at 23:59 Friday (unlikely, but handled)
    expect(resolveServiceDate('Saturday', sast('2026-11-06T23:59:00'), 290)).toBe(sast('2026-11-07T00:00:00'));
  });

  it('falls back to the service-day start when the weekday is missing', () => {
    expect(resolveServiceDate('', sast('2026-11-07T00:30:00'), 290)).toBe(sast('2026-11-06T00:00:00'));
    expect(resolveServiceDate(null, sast('2026-11-07T09:00:00'), 290)).toBe(sast('2026-11-07T00:00:00'));
  });
});

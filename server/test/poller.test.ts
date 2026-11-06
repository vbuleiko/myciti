import type { PreparedTrip } from '@myciti/shared';
import { describe, expect, it } from 'vitest';
import { planNextPoll, type PlanConfig } from '../src/poller';
import { tripsInWindow } from '../src/stores/realtime-store';

const sast = (iso: string) => Date.parse(`${iso}+02:00`);
const MIN = 60_000;
const cfg: PlanConfig = {
  pollLiveMs: 60_000,
  pollUntrackedMs: 180_000,
  pollIdleMaxMs: 3_600_000,
  leadMs: 10 * MIN,
  timezone: 'Africa/Johannesburg',
};

function trip(id: string, start: string, minutes: number, live: boolean, delayMin = 0): PreparedTrip {
  const s = sast(`2026-11-06T${start}:00`);
  const stops = [0, minutes].map((m, i) => ({
    stopId: `S${i}`,
    name: `S${i}`,
    sched: s + m * MIN,
    raw: s + (m + delayMin) * MIN,
    fit: s + (m + delayMin) * MIN,
    live,
    outlier: false,
    dist: i * 1000,
  }));
  return {
    key: `X:${id}`,
    routeId: 'X',
    directionId: 0,
    tripId: id,
    headsign: 'X',
    fetchedAt: 0,
    live,
    suspect: false,
    maxAbsDelayMin: delayMin,
    stops,
  };
}

describe('planNextPoll', () => {
  it('polls every minute while buses are tracked', () => {
    const p = planNextPoll([trip('a', '10:00', 30, true)], sast('2026-11-06T10:10:00'), cfg);
    expect(p).toMatchObject({ mode: 'live', delayMs: 60_000 });
  });

  it('keeps polling every minute when service runs on a tracked route but this trip is not live yet', () => {
    const trips = [trip('past', '08:00', 30, true), trip('now', '10:00', 30, false)];
    expect(planNextPoll(trips, sast('2026-11-06T10:05:00'), cfg)).toMatchObject({ mode: 'live', delayMs: 60_000 });
  });

  it('polls less often when a route has no live data at all today', () => {
    const trips = [trip('a', '08:00', 30, false), trip('b', '10:00', 30, false)];
    expect(planNextPoll(trips, sast('2026-11-06T10:05:00'), cfg)).toMatchObject({ mode: 'untracked', delayMs: 180_000 });
  });

  it('sleeps until shortly before the next departure', () => {
    const trips = [trip('a', '07:00', 30, true), trip('b', '16:00', 30, false)];
    const p = planNextPoll(trips, sast('2026-11-06T15:00:00'), cfg);
    expect(p.mode).toBe('idle');
    expect(p.delayMs).toBe(50 * MIN); // 16:00 - 10 min lead - 15:00
    const far = planNextPoll(trips, sast('2026-11-06T09:00:00'), cfg);
    expect(far.delayMs).toBe(3_600_000); // capped
  });

  it('pauses overnight until shortly before tomorrow\'s first departure', () => {
    const trips = [trip('a', '05:00', 30, true), trip('b', '21:00', 60, true)];
    const now = sast('2026-11-06T22:30:00');
    const p = planNextPoll(trips, now, cfg);
    expect(p.mode).toBe('night');
    expect(now + p.delayMs).toBe(sast('2026-11-07T04:30:00'));
  });

  it('a route with no trips today is re-checked within 12 hours', () => {
    const p = planNextPoll([], sast('2026-11-06T12:00:00'), cfg);
    expect(p.mode).toBe('night');
    expect(p.delayMs).toBeLessThanOrEqual(12 * 60 * MIN);
  });
});

describe('tripsInWindow', () => {
  it('keeps live trips that are running, about to start or just finished', () => {
    const now = sast('2026-11-06T10:00:00');
    const trips = [
      trip('running', '09:50', 20, true),
      trip('soon', '10:20', 20, true),
      trip('later', '11:00', 20, true),
      trip('done', '09:00', 20, true),
      trip('justdone', '09:30', 27, true),
      trip('notlive', '09:50', 20, false),
    ];
    expect(tripsInWindow(trips, now).map((t) => t.tripId)).toEqual(['running', 'soon', 'justdone']);
  });
});

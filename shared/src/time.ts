export const MIN_MS = 60_000;
export const DAY_MIN = 1440;
export const DAY_MS = DAY_MIN * MIN_MS;
export const DEFAULT_TZ = 'Africa/Johannesburg';

/** "HH:MM" (or "H:MM", hours may exceed 23) -> minutes after midnight; null if unparseable. */
export function parseClock(s: string | null | undefined): number | null {
  if (typeof s !== 'string') return null;
  const m = /^\s*(\d{1,2}):(\d{2})(?::\d{2})?\s*$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59 || h > 47) return null;
  return h * 60 + min;
}

/** Normalise a minute difference into [-720, 720). */
export function wrapMinutes(diff: number): number {
  return ((((diff + 720) % DAY_MIN) + DAY_MIN) % DAY_MIN) - 720;
}

/**
 * Given clock minutes of events that all happen within less than 24h, find where the
 * sequence starts: the minute right after the largest circular gap.
 * Returns clock minutes in [0, 1440).
 */
export function circularStart(minutes: number[]): number {
  const uniq = [...new Set(minutes.map((m) => ((m % DAY_MIN) + DAY_MIN) % DAY_MIN))].sort((a, b) => a - b);
  if (uniq.length === 0) return 0;
  if (uniq.length === 1) return uniq[0]!;
  let bestGap = -1;
  let start = uniq[0]!;
  for (let i = 0; i < uniq.length; i++) {
    const cur = uniq[i]!;
    const next = i + 1 < uniq.length ? uniq[i + 1]! : uniq[0]! + DAY_MIN;
    const gap = next - cur;
    if (gap > bestGap) {
      bestGap = gap;
      start = next % DAY_MIN;
    }
  }
  return start;
}

/**
 * Start of a service day given the clock minutes of all trip starts: the end of the night
 * gap. The gap that contains `boundaryMin` (03:00 by default) is used if it is at least
 * `minGap` long (works for routes with few trips); otherwise the largest gap.
 */
export function serviceDayStartFrom(starts: number[], boundaryMin = 180, minGap = 120): number {
  const uniq = [...new Set(starts.map((m) => ((m % DAY_MIN) + DAY_MIN) % DAY_MIN))].sort((a, b) => a - b);
  if (uniq.length === 0) return boundaryMin;
  for (let i = 0; i < uniq.length; i++) {
    const cur = uniq[i]!;
    const next = i + 1 < uniq.length ? uniq[i + 1]! : uniq[0]! + DAY_MIN;
    const b = boundaryMin <= cur ? boundaryMin + DAY_MIN : boundaryMin;
    if (cur < b && b <= next && next - cur >= minGap) return next % DAY_MIN;
  }
  return circularStart(uniq);
}

/** Unwrap clock minutes so that they are >= start (adds 1440 to values before start). */
export function unwrapFrom(minute: number, start: number): number {
  const m = ((minute % DAY_MIN) + DAY_MIN) % DAY_MIN;
  return m >= start ? m : m + DAY_MIN;
}

// ---------------------------------------------------------------------------
// Time zone helpers (Intl based, no dependencies)
// ---------------------------------------------------------------------------

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'long',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string; // "Friday"
}

export function zonedParts(epochMs: number, tz: string = DEFAULT_TZ): ZonedParts {
  const parts = fmt(tz).formatToParts(new Date(epochMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: get('weekday'),
  };
}

/** UTC offset of `tz` at `epochMs`, in ms (SAST -> +7_200_000). */
export function tzOffsetMs(epochMs: number, tz: string = DEFAULT_TZ): number {
  const p = zonedParts(epochMs, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/** Epoch ms of local midnight for a local calendar date. */
export function midnightOf(year: number, month: number, day: number, tz: string = DEFAULT_TZ): number {
  const guess = Date.UTC(year, month - 1, day);
  const off1 = tzOffsetMs(guess - tzOffsetMs(guess, tz), tz);
  return guess - off1;
}

/** Epoch ms of local midnight of the local date containing `epochMs`. */
export function localMidnight(epochMs: number, tz: string = DEFAULT_TZ): number {
  const p = zonedParts(epochMs, tz);
  return midnightOf(p.year, p.month, p.day, tz);
}

/** Midnight `days` calendar days after the given local midnight. */
export function addDays(midnight: number, days: number, tz: string = DEFAULT_TZ): number {
  const p = zonedParts(midnight + 12 * 3_600_000, tz); // noon avoids DST edge cases
  return midnightOf(p.year, p.month, p.day + days, tz);
}

/** Minutes after local midnight. */
export function localMinuteOfDay(epochMs: number, tz: string = DEFAULT_TZ): number {
  const p = zonedParts(epochMs, tz);
  return p.hour * 60 + p.minute + p.second / 60;
}

export function weekdayOf(epochMs: number, tz: string = DEFAULT_TZ): string {
  return zonedParts(epochMs, tz).weekday;
}

/**
 * Work out which calendar date a timetable page refers to.
 *
 * The page carries only a weekday name (`day`, e.g. "Friday"). We pick the date closest to
 * `fetchedAt` (yesterday / today / tomorrow) with that weekday name. If `day` is missing or
 * unrecognised we fall back to: before `serviceStartMin` (early morning) -> yesterday, else today.
 *
 * Returns epoch ms of local midnight of that date.
 */
export function resolveServiceDate(
  day: string | null | undefined,
  fetchedAt: number,
  serviceStartMin: number,
  tz: string = DEFAULT_TZ,
): number {
  const today = localMidnight(fetchedAt, tz);
  const wanted = (day ?? '').trim().toLowerCase();
  if (wanted) {
    for (const offset of [0, -1, 1]) {
      const d = offset === 0 ? today : addDays(today, offset, tz);
      if (weekdayOf(d + 12 * 3_600_000, tz).toLowerCase() === wanted) return d;
    }
  }
  const nowMin = localMinuteOfDay(fetchedAt, tz);
  // e.g. fetched at 00:40 while the service day starts at 04:30 -> still yesterday's service.
  if (serviceStartMin > 0 && nowMin < serviceStartMin - 60 && nowMin < 6 * 60) return addDays(today, -1, tz);
  return today;
}

/** "HH:MM" in `tz` for an epoch. */
export function formatClock(epochMs: number, tz: string = DEFAULT_TZ): string {
  const p = zonedParts(epochMs, tz);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

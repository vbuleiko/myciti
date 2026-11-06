import type { RawDirectionTimetable, RawStopTime, RawTrip } from '@myciti/shared';
import { z } from 'zod';
import { extractJsVar, extractOptionalJsVar } from './extract';

const idStr = z.union([z.string(), z.number()]).transform(String);

const StopSchema = z.object({
  id: idStr,
  name: z.string().nullish(),
  is_station: z.union([z.boolean(), z.number(), z.string()]).nullish(),
  static_time: z.string(),
  time: z.string().nullish(),
  delay: z.string().nullish(),
});

const TripSchema = z.object({
  trip_id: idStr,
  start_time: z.string().nullish(),
  stops: z.array(z.unknown()).default([]),
});

const DirectionSchema = z.object({
  route: idStr,
  direction: z.union([z.number(), z.string()]).transform(Number),
  route_name: z.string().nullish(),
  day: z.string().nullish(),
  service_advisory: z.unknown().nullish(),
  trips: z.array(z.unknown()).default([]),
});

export interface ParsedTimetablePage {
  routeId: string;
  directions: RawDirectionTimetable[];
  /** `var directions` (headsigns) as published */
  headsigns: { directionId: number; headsign: string }[];
  pageUrl: string | null;
  warnings: string[];
}

function truthy(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'true';
}

/** Parse a route timetable page (`var timetable`, `var directions`, `var page_url`). */
export function parseTimetablePage(html: string, expectedRouteId?: string): ParsedTimetablePage {
  const warnings: string[] = [];
  const tt = extractJsVar(html, 'timetable');
  if (!Array.isArray(tt)) throw new Error('`timetable` is not an array (layout changed?)');

  const directions: RawDirectionTimetable[] = [];
  for (const d of tt) {
    const dr = DirectionSchema.safeParse(d);
    if (!dr.success) {
      warnings.push(`direction skipped: ${dr.error.issues[0]?.message ?? 'invalid'}`);
      continue;
    }
    const trips: RawTrip[] = [];
    let badStops = 0;
    for (const t of dr.data.trips) {
      const tr = TripSchema.safeParse(t);
      if (!tr.success) {
        warnings.push(`trip skipped in ${dr.data.route}/${dr.data.direction}`);
        continue;
      }
      const stops: RawStopTime[] = [];
      for (const s of tr.data.stops) {
        const sr = StopSchema.safeParse(s);
        if (!sr.success) {
          badStops++;
          continue;
        }
        const x = sr.data;
        stops.push({
          stopId: x.id,
          name: x.name ?? x.id,
          isStation: truthy(x.is_station),
          staticTime: x.static_time,
          time: x.time && x.time.trim() ? x.time : x.static_time,
          live: (x.delay ?? '').trim().toLowerCase() === 'live',
        });
      }
      if (stops.length) trips.push({ tripId: tr.data.trip_id, startTime: tr.data.start_time ?? '', stops });
    }
    if (badStops) warnings.push(`${badStops} stop rows skipped in ${dr.data.route}/${dr.data.direction}`);
    const adv = dr.data.service_advisory;
    directions.push({
      routeId: dr.data.route,
      directionId: dr.data.direction,
      routeName: dr.data.route_name ?? '',
      day: dr.data.day ?? '',
      serviceAdvisory: typeof adv === 'string' && adv.trim() ? adv : null,
      trips,
    });
  }

  const routeId = directions[0]?.routeId ?? expectedRouteId ?? '';
  if (expectedRouteId && directions.some((d) => d.routeId !== expectedRouteId)) {
    warnings.push(`page contains route ${directions.map((d) => d.routeId).join(',')} instead of ${expectedRouteId}`);
  }

  const headsignsRaw = extractOptionalJsVar(html, 'directions');
  const headsigns = Array.isArray(headsignsRaw)
    ? headsignsRaw
        .map((h) => {
          const o = h as { direction_id?: unknown; trip_headsign?: unknown };
          return { directionId: Number(o.direction_id), headsign: String(o.trip_headsign ?? '') };
        })
        .filter((h) => Number.isFinite(h.directionId))
    : [];

  const pageUrlMatch = /\bpage_url\s*=\s*"([^"]*)"/.exec(html);

  return { routeId, directions, headsigns, pageUrl: pageUrlMatch?.[1] ?? null, warnings };
}

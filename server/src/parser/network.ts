import type { LngLat, Network, NetworkRoute, NetworkStop } from '@myciti/shared';
import { z } from 'zod';
import { extractJsVar, extractOptionalJsVar } from './extract';

const num = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/).transform(Number)]);
const idStr = z.union([z.string(), z.number()]).transform(String);

const DirectionSchema = z.object({
  direction_id: z.union([z.number(), z.string()]).transform(Number),
  trip_headsign: z.string().nullish(),
  stops: z.array(idStr).default([]),
  route_points: z.array(z.tuple([num, num]).or(z.array(num))).default([]),
});

const RouteSchema = z.object({
  id: idStr,
  name: z.string().nullish(),
  long_name: z.string().nullish(),
  route_colour: z.string().nullish(),
  route_text_colour: z.string().nullish(),
  directions: z.array(DirectionSchema).default([]),
});

const StopSchema = z.object({
  id: idStr,
  name: z.string().nullish(),
  latitude: num,
  longitude: num,
  routes: z.array(idStr).nullish(),
});

const ShapeSchema = z.object({
  name: z.string().nullish(),
  long_name: z.string().nullish(),
  colour: z.string().nullish(),
  text_colour: z.string().nullish(),
  points: z.array(z.array(num)).default([]),
});

export interface ParsedNetwork extends Network {
  /** map_shapes as published: polylines per route variant (not used for positioning) */
  shapes: { name: string; longName: string; color: string; points: LngLat[] }[];
  warnings: string[];
}

export function normalizeColor(c: string | null | undefined, fallback: string): string {
  const s = (c ?? '').trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(s)) return `#${s.toUpperCase()}`;
  if (/^[0-9a-fA-F]{3}$/.test(s)) return `#${s.toUpperCase()}`;
  return fallback;
}

function latLngToLngLat(p: number[]): LngLat | null {
  const lat = p[0];
  const lng = p[1];
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return [lng, lat];
}

function dedupeConsecutive(ids: string[]): string[] {
  return ids.filter((id, i) => i === 0 || ids[i - 1] !== id);
}

function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return Object.values(v);
  return [];
}

/** Parse the route/stop/station map page (`map_routes`, `map_stops`, `map_shapes`). */
export function parseNetworkPage(html: string, fetchedAt: number): ParsedNetwork {
  const warnings: string[] = [];
  const routesRaw = asArray(extractJsVar(html, 'map_routes'));
  const stopsRaw = asArray(extractJsVar(html, 'map_stops'));
  const shapesRaw = asArray(extractOptionalJsVar(html, 'map_shapes') ?? []);

  const routes: NetworkRoute[] = [];
  for (const r of routesRaw) {
    const res = RouteSchema.safeParse(r);
    if (!res.success) {
      warnings.push(`route skipped: ${res.error.issues[0]?.message ?? 'invalid'}`);
      continue;
    }
    const x = res.data;
    routes.push({
      id: x.id,
      name: x.name ?? x.id,
      longName: x.long_name ?? '',
      color: normalizeColor(x.route_colour, '#3366CC'),
      textColor: normalizeColor(x.route_text_colour, '#FFFFFF'),
      directions: x.directions.map((d) => ({
        directionId: d.direction_id,
        headsign: d.trip_headsign ?? '',
        stopIds: dedupeConsecutive(d.stops),
        shape: d.route_points.map((p) => latLngToLngLat(p as number[])).filter((p): p is LngLat => p !== null),
      })),
    });
  }

  const stops: NetworkStop[] = [];
  for (const s of stopsRaw) {
    const res = StopSchema.safeParse(s);
    if (!res.success) {
      warnings.push(`stop skipped: ${res.error.issues[0]?.message ?? 'invalid'}`);
      continue;
    }
    const x = res.data;
    if (!Number.isFinite(x.latitude) || !Number.isFinite(x.longitude)) continue;
    stops.push({ id: x.id, name: x.name ?? x.id, lat: x.latitude, lng: x.longitude, routes: x.routes ?? [] });
  }

  const shapes: ParsedNetwork['shapes'] = [];
  for (const s of shapesRaw) {
    const res = ShapeSchema.safeParse(s);
    if (!res.success) continue;
    shapes.push({
      name: res.data.name ?? '',
      longName: res.data.long_name ?? '',
      color: normalizeColor(res.data.colour, '#3366CC'),
      points: res.data.points.map(latLngToLngLat).filter((p): p is LngLat => p !== null),
    });
  }

  if (routes.length === 0) throw new Error('network page: no routes parsed (layout changed?)');
  if (stops.length === 0) throw new Error('network page: no stops parsed (layout changed?)');

  const stopIds = new Set(stops.map((s) => s.id));
  for (const r of routes) {
    for (const d of r.directions) {
      const missing = d.stopIds.filter((id) => !stopIds.has(id));
      if (missing.length) warnings.push(`route ${r.id}/${d.directionId}: unknown stops ${missing.join(',')}`);
      if (d.shape.length < 2) warnings.push(`route ${r.id}/${d.directionId}: no route_points`);
    }
  }

  return { fetchedAt, routes, stops, shapes, warnings };
}

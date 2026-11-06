import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractJsVar, findJsLiteral, ExtractError } from '../src/parser/extract';
import { parseNetworkPage } from '../src/parser/network';
import { parseTimetablePage } from '../src/parser/timetable';

const fixture = (name: string) => readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), 'utf8');

describe('findJsLiteral / extractJsVar', () => {
  it('extracts arrays and objects with nested brackets inside strings', () => {
    const html = `<script>
      var a = 1; var data = [{"x":"]}[{","y":[1,2,{"z":"a\\"b"}]}];
      var other = {"k": "v"};
    </script>`;
    expect(extractJsVar(html, 'data')).toEqual([{ x: ']}[{', y: [1, 2, { z: 'a"b' }] }]);
    expect(extractJsVar(html, 'other')).toEqual({ k: 'v' });
  });

  it('handles assignments without var and ignores property assignments', () => {
    const html = `<script>obj.timetable = [9]; timetable = [1,2];</script>`;
    expect(extractJsVar(html, 'timetable')).toEqual([1, 2]);
  });

  it('falls back to JSON5 for JS-style literals (no eval)', () => {
    const html = `<script>var cfg = {a: 1, 'b': [2, 3,], // comment
      c: "x"};</script>`;
    expect(extractJsVar(html, 'cfg')).toEqual({ a: 1, b: [2, 3], c: 'x' });
  });

  it('does not execute code-like values', () => {
    const html = `<script>var evil = [alert(1)];</script>`;
    expect(() => extractJsVar(html, 'evil')).toThrow(ExtractError);
  });

  it('reports missing variables', () => {
    expect(findJsLiteral('<p>nothing</p>', 'timetable')).toBeNull();
    expect(() => extractJsVar('<p>nothing</p>', 'timetable')).toThrow(/not found/);
  });
});

describe('parseNetworkPage (fixture 2026-11-06)', () => {
  const net = parseNetworkPage(fixture('network-map.html'), 1);

  it('finds the published counts', () => {
    expect(net.routes).toHaveLength(47);
    expect(net.routes.reduce((s, r) => s + r.directions.length, 0)).toBe(92);
    expect(net.stops).toHaveLength(530);
    expect(net.shapes).toHaveLength(92);
  });

  it('normalises route 101', () => {
    const r = net.routes.find((x) => x.id === '101')!;
    expect(r.name).toBe('101');
    expect(r.longName).toMatch(/Vredehoek/);
    expect(r.color).toBe('#82C341');
    expect(r.textColor).toBe('#231F20');
    const d1 = r.directions.find((d) => d.directionId === 1)!;
    expect(d1.headsign).toBe('101 Civic Centre');
    // consecutive duplicate "CIVIC CIVIC" removed
    expect(d1.stopIds.at(-1)).toBe('CIVIC');
    expect(d1.stopIds.at(-2)).toBe('ADLEY');
    // shape is [lng, lat] around Cape Town
    const [lng, lat] = d1.shape[0]!;
    expect(lng).toBeGreaterThan(18);
    expect(lat).toBeLessThan(-33);
  });

  it('every direction stop exists and every direction has a shape', () => {
    const ids = new Set(net.stops.map((s) => s.id));
    for (const r of net.routes) {
      for (const d of r.directions) {
        expect(d.shape.length, `${r.id}/${d.directionId}`).toBeGreaterThan(1);
        for (const s of d.stopIds) expect(ids.has(s), s).toBe(true);
      }
    }
    expect(net.warnings).toEqual([]);
  });

  it('parses stops', () => {
    const s = net.stops.find((x) => x.id === 'GRDNS')!;
    expect(s.name).toBe('Gardens');
    expect(s.lat).toBeCloseTo(-33.93, 1);
    expect(s.routes.length).toBeGreaterThan(0);
  });

  it('accepts map_routes published as an object', () => {
    const html = `<script>map_routes = {"a":{"id":"X1","name":"X1","directions":[]}};
      map_stops = [{"id":"S","name":"S","latitude":-33.9,"longitude":18.4,"routes":[]}];</script>`;
    const n = parseNetworkPage(html, 0);
    expect(n.routes.map((r) => r.id)).toEqual(['X1']);
  });
});

describe('parseTimetablePage (fixtures 2026-11-06 ~15:16 SAST)', () => {
  it('route 101', () => {
    const p = parseTimetablePage(fixture('route-101.html'), '101');
    expect(p.routeId).toBe('101');
    expect(p.pageUrl).toContain('route=101');
    expect(p.headsigns).toEqual([
      { directionId: 0, headsign: '101 Vredehoek' },
      { directionId: 1, headsign: '101 Civic Centre' },
    ]);
    expect(p.directions).toHaveLength(2);
    const d0 = p.directions[0]!;
    expect(d0.day).toBe('Friday');
    expect(d0.directionId).toBe(0);
    expect(d0.trips).toHaveLength(14);
    const t = d0.trips[0]!;
    expect(t.tripId).toBe('109434');
    expect(t.stops[0]).toEqual({
      stopId: 'CIVIC',
      name: 'Civic Centre',
      isStation: false,
      staticTime: '05:56',
      time: '05:36',
      live: true,
    });
    const live = d0.trips.filter((x) => x.stops.some((s) => s.live)).length;
    expect(live).toBe(10);
    expect(p.warnings).toEqual([]);
  });

  it('T01 (large page, short-turn variants, mixed live/scheduled trips)', () => {
    const p = parseTimetablePage(fixture('route-T01.html'), 'T01');
    expect(p.directions.map((d) => d.trips.length)).toEqual([110, 111]);
    const lens = new Set(p.directions[0]!.trips.map((t) => t.stops.length));
    expect(lens).toEqual(new Set([20, 24]));
    const mixed = p.directions[1]!.trips.filter((t) => t.stops.some((s) => s.live) && t.stops.some((s) => !s.live));
    expect(mixed.length).toBe(6);
  });

  it('D01', () => {
    const p = parseTimetablePage(fixture('route-D01.html'), 'D01');
    expect(p.directions.map((d) => d.trips.length)).toEqual([41, 41]);
    expect(p.warnings).toEqual([]);
  });

  it('213: single-direction loop route, timetable published as an object keyed by direction', () => {
    const p = parseTimetablePage(fixture('route-213.html'), '213');
    expect(p.directions).toHaveLength(1);
    expect(p.directions[0]!.directionId).toBe(1);
    expect(p.directions[0]!.trips.length).toBeGreaterThan(10);
    expect(p.headsigns).toEqual([{ directionId: 1, headsign: '213 Table View' }]);
  });

  it('rejects pages without a timetable', () => {
    expect(() => parseTimetablePage('<html><body>Maintenance</body></html>')).toThrow(/timetable/);
  });

  it('accepts an empty timetable (no service)', () => {
    const p = parseTimetablePage('<script>var timetable = [];</script>', '999');
    expect(p.directions).toEqual([]);
    expect(p.routeId).toBe('999');
  });
});

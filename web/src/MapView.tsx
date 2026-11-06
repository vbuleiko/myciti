import { estimateAll, stopDistanceM, type EngineOptions, type NetworkIndex, type PreparedTrip } from '@myciti/shared';
import {
  AttributionControl,
  GeolocateControl,
  MapLibreMap,
  NavigationControl,
  Popup,
  setWorkerUrl,
  type GeoJSONSource,
  type MapLayerMouseEvent,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre 6 looks for its worker next to its own module, which does not exist once Vite has
// bundled it; hand it the worker file as a same-origin asset instead (CSP: worker-src 'self').
import mapWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { useEffect, useRef, useState } from 'react';
import type { NetworkPayload } from './api';
import { VehicleAnimator, type AnimatedVehicle } from './animator';
import { ageText, clock, delayText, esc } from './format';
import { busMarkerSdf } from './markers';

export interface MapFilters {
  routes: Set<string>; // selected route ids
  showStops: boolean;
  showLines: boolean;
  highlightSuspect: boolean;
  hideSuspect: boolean;
}

interface Props {
  network: NetworkPayload | null;
  idx: NetworkIndex | null;
  tripsRef: React.RefObject<Map<string, PreparedTrip[]>>;
  engine: EngineOptions;
  clockOffsetRef: React.RefObject<number>;
  filters: MapFilters;
  onStats: (s: { total: number; suspect: number; byRoute: Record<string, number> }) => void;
}

setWorkerUrl(mapWorkerUrl);

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const CAPE_TOWN: [number, number] = [18.47, -33.93];
const FRAME_MS = 50; // ~20 fps is plenty for buses
/** when a frame costs this much CPU, animate more slowly instead of stuttering */
const SLOW_FRAME_MS = 20;
const SUSPECT_COLOR = '#8c8c8c';

const emptyFC = (): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features: [] });

export function MapView({ network, idx, tripsRef, engine, clockOffsetRef, filters, onStats }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const readyRef = useRef(false);
  const animatorRef = useRef<VehicleAnimator | null>(null);
  const filtersRef = useRef(filters);
  const engineRef = useRef(engine);
  const selectedRef = useRef<string | null>(null);
  const popupRef = useRef<Popup | null>(null);
  const lastPopupHtml = useRef('');
  const vehiclesRef = useRef<AnimatedVehicle[]>([]);
  const onStatsRef = useRef(onStats);
  const networkRef = useRef(network);
  const idxRef = useRef(idx);
  const [mapReady, setMapReady] = useState(false);
  networkRef.current = network;
  idxRef.current = idx;
  filtersRef.current = filters;
  engineRef.current = engine;
  onStatsRef.current = onStats;

  // ---------------------------------------------------------------- map init
  useEffect(() => {
    const map = new MapLibreMap({
      container: containerRef.current!,
      style: STYLE_URL,
      center: CAPE_TOWN,
      zoom: 11,
      attributionControl: false,
      maxPitch: 0,
    });
    map.addControl(
      new AttributionControl({
        compact: true,
        customAttribution:
          'Данные о маршрутах: <a href="https://www.myciti.org.za" target="_blank" rel="noopener">MyCiTi / City of Cape Town</a> · позиции расчётные',
      }),
    );
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new GeolocateControl({ trackUserLocation: false }), 'top-right');
    map.touchZoomRotate.disableRotation();
    map.dragRotate.disable();
    mapRef.current = map;
    if (import.meta.env.DEV) (window as unknown as { __mycitiMap?: MapLibreMap }).__mycitiMap = map;

    map.on('load', () => {
      const icon = busMarkerSdf(64, 2);
      map.addImage('myciti-bus', { width: icon.width, height: icon.height, data: icon.data }, { sdf: true, pixelRatio: icon.pixelRatio });

      map.addSource('lines', { type: 'geojson', data: emptyFC() });
      map.addSource('stops', { type: 'geojson', data: emptyFC() });
      map.addSource('vehicles', { type: 'geojson', data: emptyFC() });

      map.addLayer({
        id: 'route-lines',
        type: 'line',
        source: 'lines',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 15, 4],
          'line-opacity': 0.45,
        },
      });
      map.addLayer({
        id: 'stops',
        type: 'circle',
        source: 'stops',
        minzoom: 12,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 2.5, 16, 5],
          'circle-color': '#ffffff',
          'circle-stroke-color': '#334155',
          'circle-stroke-width': 1.2,
        },
      });
      map.addLayer({
        id: 'stop-labels',
        type: 'symbol',
        source: 'stops',
        minzoom: 15,
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Regular'],
          'text-size': 11,
          'text-offset': [0, 1],
          'text-anchor': 'top',
          'text-optional': true,
        },
        paint: { 'text-color': '#334155', 'text-halo-color': '#ffffff', 'text-halo-width': 1.2 },
      });
      map.addLayer({
        id: 'vehicles',
        type: 'symbol',
        source: 'vehicles',
        layout: {
          'icon-image': 'myciti-bus',
          'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.45, 13, 0.6, 16, 0.75],
          'icon-rotate': ['get', 'bearing'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'text-field': ['get', 'route'],
          'text-font': ['Noto Sans Bold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 9, 8, 13, 10, 16, 12],
          'text-allow-overlap': true,
          'text-ignore-placement': true,
          'symbol-sort-key': ['get', 'sort'],
        },
        paint: {
          'icon-color': ['get', 'fill'],
          'icon-halo-color': ['get', 'halo'],
          'icon-halo-width': ['get', 'haloWidth'],
          'icon-opacity': ['get', 'opacity'],
          'text-color': ['get', 'textColor'],
          'text-opacity': ['get', 'opacity'],
        },
      });

      const clickable = ['vehicles', 'stops'];
      for (const l of clickable) {
        map.on('mouseenter', l, () => (map.getCanvas().style.cursor = 'pointer'));
        map.on('mouseleave', l, () => (map.getCanvas().style.cursor = ''));
      }
      map.on('click', 'vehicles', (e: MapLayerMouseEvent) => {
        const key = e.features?.[0]?.properties?.key as string | undefined;
        if (key) openVehiclePopup(key);
      });
      map.on('click', 'stops', (e: MapLayerMouseEvent) => {
        if (map.queryRenderedFeatures(e.point, { layers: ['vehicles'] }).length) return;
        const f = e.features?.[0];
        if (f) openStopPopup(String(f.properties?.id), (f.geometry as GeoJSON.Point).coordinates as [number, number]);
      });
      readyRef.current = true;
      setMapReady(true);
    });

    return () => {
      readyRef.current = false;
      setMapReady(false);
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------- popups
  const now = () => Date.now() + (clockOffsetRef.current ?? 0);

  function closePopup() {
    popupRef.current?.remove();
    popupRef.current = null;
    selectedRef.current = null;
    lastPopupHtml.current = '';
  }

  function openVehiclePopup(key: string) {
    const map = mapRef.current;
    if (!map) return;
    popupRef.current?.remove();
    selectedRef.current = key;
    lastPopupHtml.current = '';
    const v = vehiclesRef.current.find((x) => x.trip.key === key);
    const popup = new Popup({ closeButton: true, closeOnClick: true, maxWidth: '320px', offset: 14 })
      .setLngLat(v ? [v.lng, v.lat] : map.getCenter())
      .setHTML('…')
      .addTo(map);
    popup.on('close', () => {
      if (popupRef.current === popup) {
        popupRef.current = null;
        selectedRef.current = null;
      }
    });
    popupRef.current = popup;
    if (v) updateVehiclePopup(v);
  }

  function vehicleHtml(v: AnimatedVehicle): string {
    const idx = idxRef.current;
    const t = v.trip;
    const route = idx?.routes.get(t.routeId);
    const prev = t.stops[v.est.prevIdx]!;
    const next = t.stops[v.est.nextIdx]!;
    const n = now();
    const stopLine = (label: string, s: typeof prev) =>
      `<div class="pp-row"><span class="pp-k">${label}</span><span>${esc(s.name)} <b>${clock(s.fit)}</b>` +
      (Math.abs(s.fit - s.sched) >= 60_000 ? ` <s class="pp-sched">${clock(s.sched)}</s>` : '') +
      `</span></div>`;
    const state =
      v.est.state === 'waiting'
        ? `${stopLine('Стоит на', prev)}<div class="pp-row"><span class="pp-k">Отправление</span><span>${clock(prev.fit)}</span></div>`
        : v.est.state === 'arrived'
          ? stopLine('Прибыл на', prev)
          : stopLine('Предыдущая', prev) + stopLine('Следующая', next);
    return (
      `<div class="pp">` +
      `<div class="pp-head"><span class="pp-badge" style="background:${route?.color ?? '#333'};color:${route?.textColor ?? '#fff'}">${esc(route?.name ?? t.routeId)}</span>` +
      `<span class="pp-title">${esc(t.headsign)}</span></div>` +
      (t.suspect
        ? `<div class="pp-warn">⚠ Подозрительные данные: отклонение до ${t.maxAbsDelayMin} мин от расписания. Система могла привязать автобус к соседнему рейсу.</div>`
        : '') +
      state +
      `<div class="pp-row"><span class="pp-k">Отклонение</span><span>${delayText(v.est.delaySec)}</span></div>` +
      (v.est.state === 'moving'
        ? `<div class="pp-row"><span class="pp-k">Скорость</span><span>${Math.round(v.shownSpeedMps * 3.6)} км/ч <span class="pp-sched">(перегон ${Math.round(v.est.speedMps * 3.6)})</span></span></div>`
        : '') +
      `<div class="pp-row"><span class="pp-k">Рейс</span><span>trip_id ${esc(t.tripId)}${v.mergedFrom ? ` (прибыл рейсом ${esc(v.mergedFrom.split(':')[1] ?? '')})` : ''}</span></div>` +
      `<div class="pp-row"><span class="pp-k">Данные</span><span>${ageText(n - t.fetchedAt)}</span></div>` +
      `<div class="pp-note">Позиция расчётная: интерполяция по времени прохождения остановок, не GPS.</div>` +
      `</div>`
    );
  }

  function updateVehiclePopup(v: AnimatedVehicle) {
    const popup = popupRef.current;
    if (!popup) return;
    popup.setLngLat([v.lng, v.lat]);
    const html = vehicleHtml(v);
    if (html !== lastPopupHtml.current) {
      popup.setHTML(html);
      lastPopupHtml.current = html;
    }
  }

  function openStopPopup(stopId: string, coords: [number, number]) {
    const map = mapRef.current;
    const idx = idxRef.current;
    if (!map || !idx) return;
    popupRef.current?.remove();
    selectedRef.current = null;
    const stop = idx.stops.get(stopId);
    const n = now();
    const arrivals: { route: string; headsign: string; t: number; delay: number; suspect: boolean }[] = [];
    for (const trips of tripsRef.current?.values() ?? []) {
      for (const t of trips) {
        for (const s of t.stops) {
          if (s.stopId === stopId && s.fit >= n - 30_000 && s.fit <= n + 90 * 60_000) {
            arrivals.push({ route: t.routeId, headsign: t.headsign, t: s.fit, delay: s.fit - s.sched, suspect: t.suspect });
          }
        }
      }
    }
    arrivals.sort((a, b) => a.t - b.t);
    const rows = arrivals
      .slice(0, 8)
      .map((a) => {
        const r = idx.routes.get(a.route);
        const mins = Math.max(0, Math.round((a.t - n) / 60_000));
        return (
          `<div class="pp-row"><span><span class="pp-badge sm" style="background:${r?.color};color:${r?.textColor}">${esc(r?.name ?? a.route)}</span> ${esc(a.headsign.replace(/^\S+\s/, ''))}</span>` +
          `<span><b>${mins === 0 ? 'сейчас' : `${mins} мин`}</b> <span class="pp-sched">${clock(a.t)}</span>${a.suspect ? ' ⚠' : ''}</span></div>`
        );
      })
      .join('');
    const routes = (stop?.routes ?? [])
      .map((rid) => {
        const r = idx.routes.get(rid);
        return `<span class="pp-badge sm" style="background:${r?.color ?? '#333'};color:${r?.textColor ?? '#fff'}">${esc(r?.name ?? rid)}</span>`;
      })
      .join(' ');
    const html =
      `<div class="pp"><div class="pp-head"><span class="pp-title">${esc(stop?.name ?? stopId)}</span></div>` +
      `<div class="pp-routes">${routes}</div>` +
      (rows ? `<div class="pp-sub">Ближайшие автобусы (по живым данным)</div>${rows}` : `<div class="pp-sub">Нет отслеживаемых автобусов в ближайшие 90 мин</div>`) +
      `<div class="pp-note">Время расчётное; рейсы без живых данных не показаны.</div></div>`;
    popupRef.current = new Popup({ maxWidth: '340px', offset: 8 }).setLngLat(coords).setHTML(html).addTo(map);
  }

  // ---------------------------------------------------------------- static layers
  function updateStatic() {
    const map = mapRef.current;
    const network = networkRef.current;
    if (!map || !readyRef.current || !network) return;
    const f = filtersRef.current;
    const lines: GeoJSON.Feature[] = [];
    for (const r of network.routes) {
      if (!f.routes.has(r.id)) continue;
      for (const d of r.directions) {
        if (d.shape.length < 2) continue;
        lines.push({ type: 'Feature', properties: { route: r.id, color: r.color }, geometry: { type: 'LineString', coordinates: d.shape } });
      }
    }
    (map.getSource('lines') as GeoJSONSource).setData({ type: 'FeatureCollection', features: lines });
    const stops: GeoJSON.Feature[] = network.stops
      .filter((s) => s.routes.some((r) => f.routes.has(r)))
      .map((s) => ({ type: 'Feature', properties: { id: s.id, name: s.name }, geometry: { type: 'Point', coordinates: [s.lng, s.lat] } }));
    (map.getSource('stops') as GeoJSONSource).setData({ type: 'FeatureCollection', features: stops });
    map.setLayoutProperty('route-lines', 'visibility', f.showLines ? 'visible' : 'none');
    map.setLayoutProperty('stops', 'visibility', f.showStops ? 'visible' : 'none');
    map.setLayoutProperty('stop-labels', 'visibility', f.showStops ? 'visible' : 'none');
  }

  useEffect(() => {
    updateStatic();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network, filters, mapReady]);

  useEffect(() => {
    if (!idx) return;
    if (!animatorRef.current) animatorRef.current = new VehicleAnimator(idx);
    else animatorRef.current.setIndex(idx);
  }, [idx]);

  // ---------------------------------------------------------------- animation loop
  useEffect(() => {
    let raf = 0;
    let last = 0;
    let lastStats = 0;
    // adaptive cadence: a weak device (or hundreds of buses) gets fewer, cheaper frames
    let frameMs = FRAME_MS;
    let cost = 0;
    const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    let lastFeatureCount = -1;
    const loop = (ts: number) => {
      raf = requestAnimationFrame(loop);
      if (ts - last < (reducedMotion ? 250 : frameMs)) return;
      last = ts;
      const t0 = performance.now();
      const map = mapRef.current;
      const anim = animatorRef.current;
      if (!map || !readyRef.current || !anim || !idx) return;
      const f = filtersRef.current;
      const trips: PreparedTrip[] = [];
      for (const [routeId, arr] of tripsRef.current ?? []) if (f.routes.has(routeId)) trips.push(...arr);
      const n = now();
      const vehicles = anim.frame(trips, n, engineRef.current).filter((v) => !(f.hideSuspect && v.trip.suspect));
      vehiclesRef.current = vehicles;
      const features: GeoJSON.Feature[] = vehicles.filter((v) => Number.isFinite(v.lng) && Number.isFinite(v.lat)).map((v) => {
        const r = idx.routes.get(v.trip.routeId);
        const suspect = v.trip.suspect && f.highlightSuspect;
        const stale = n - v.trip.fetchedAt > 10 * 60_000;
        return {
          type: 'Feature',
          properties: {
            key: v.trip.key,
            route: r?.name ?? v.trip.routeId,
            bearing: Number.isFinite(v.bearing) ? v.bearing : 0,
            fill: suspect ? SUSPECT_COLOR : (r?.color ?? '#3366CC'),
            textColor: suspect ? '#ffffff' : (r?.textColor ?? '#FFFFFF'),
            halo: suspect ? '#f59e0b' : '#ffffff',
            haloWidth: suspect ? 2.5 : 1.5,
            opacity: v.est.state === 'moving' && !stale ? 1 : 0.6,
            sort: suspect ? 0 : 1,
          },
          geometry: { type: 'Point', coordinates: [v.lng, v.lat] },
        };
      });
      // nothing on the map and nothing before: skip the (not free) GeoJSON upload
      if (features.length > 0 || lastFeatureCount !== 0) {
        (map.getSource('vehicles') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features });
      }
      lastFeatureCount = features.length;

      const sel = selectedRef.current;
      if (sel) {
        const v = vehicles.find((x) => x.trip.key === sel);
        if (v) updateVehiclePopup(v);
        else if (popupRef.current) {
          popupRef.current.setHTML('<div class="pp"><div class="pp-sub">Рейс завершён или скрыт фильтром.</div></div>');
          selectedRef.current = null;
        }
      }
      if (ts - lastStats > 1000) {
        // counts for the panel: all routes, regardless of the filter
        lastStats = ts;
        const all: PreparedTrip[] = [];
        for (const arr of tripsRef.current?.values() ?? []) all.push(...arr);
        const everyBus = estimateAll(all, n, (a, b) => stopDistanceM(idx, a, b), engineRef.current);
        const byRoute: Record<string, number> = {};
        let suspect = 0;
        for (const v of everyBus) {
          byRoute[v.trip.routeId] = (byRoute[v.trip.routeId] ?? 0) + 1;
          if (v.trip.suspect) suspect++;
        }
        onStatsRef.current({ total: everyBus.length, suspect, byRoute });
      }
      const spent = performance.now() - t0;
      cost = cost * 0.8 + spent * 0.2;
      frameMs = cost > SLOW_FRAME_MS * 2 ? 150 : cost > SLOW_FRAME_MS ? 100 : FRAME_MS;
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx]);

  useEffect(() => () => closePopup(), []);

  return <div ref={containerRef} className="map" />;
}

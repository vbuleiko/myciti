import type { EngineOptions, NetworkRoute, NetworkStop, PreparedTrip } from '@myciti/shared';

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';

export interface NetworkPayload {
  fetchedAt: number;
  routes: NetworkRoute[];
  stops: NetworkStop[];
}

export interface RouteMeta {
  fetchedAt: number;
  day: string;
  serviceAdvisory: string | null;
}

export interface LivePayload {
  serverTime: number;
  engine: EngineOptions;
  routes: Record<string, RouteMeta>;
  trips: PreparedTrip[];
}

export interface RouteEvent {
  serverTime: number;
  routeId: string;
  route: RouteMeta;
  trips: PreparedTrip[];
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const fetchNetwork = () => getJson<NetworkPayload>('/api/network');
export const fetchLive = () => getJson<LivePayload>('/api/trips/live');

export interface StreamHandlers {
  onRoute: (e: RouteEvent) => void;
  onNetwork: () => void;
  onClock: (serverTime: number) => void;
  onStatus: (connected: boolean) => void;
}

/** Server-sent events with automatic reconnect (EventSource handles retries). */
export function openStream(h: StreamHandlers): () => void {
  const es = new EventSource(`${BASE}/api/stream`);
  es.addEventListener('open', () => h.onStatus(true));
  es.addEventListener('error', () => h.onStatus(false));
  es.addEventListener('hello', (e) => h.onClock(JSON.parse((e as MessageEvent).data).serverTime));
  es.addEventListener('ping', (e) => h.onClock(JSON.parse((e as MessageEvent).data).serverTime));
  es.addEventListener('route', (e) => {
    const data = JSON.parse((e as MessageEvent).data) as RouteEvent;
    h.onClock(data.serverTime);
    h.onRoute(data);
  });
  es.addEventListener('network', () => h.onNetwork());
  return () => es.close();
}

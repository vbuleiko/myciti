import {
  ClockSync,
  DEFAULT_ENGINE_OPTIONS,
  indexNetwork,
  type EngineOptions,
  type NetworkIndex,
  type PreparedTrip,
} from '@myciti/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchLive, fetchNetwork, openStream, type NetworkPayload, type RouteMeta } from './api';

export interface LiveData {
  network: NetworkPayload | null;
  idx: NetworkIndex | null;
  /** live trips per route, replaced wholesale on each route update */
  tripsRef: React.RefObject<Map<string, PreparedTrip[]>>;
  routeMeta: Record<string, RouteMeta>;
  engine: EngineOptions;
  /** server clock - local clock, ms (median of recent samples, see ClockSync) */
  clockOffsetRef: React.RefObject<number>;
  connected: boolean;
  error: string | null;
  /** bumps on every data change (cheap re-render trigger for the panel) */
  version: number;
  lastUpdateAt: number | null;
}

/** After this long without any server message the page re-syncs when it becomes visible again. */
const RESYNC_AFTER_MS = 45_000;

export function useLiveData(): LiveData {
  const [network, setNetwork] = useState<NetworkPayload | null>(null);
  const [routeMeta, setRouteMeta] = useState<Record<string, RouteMeta>>({});
  const [engine, setEngine] = useState<EngineOptions>(DEFAULT_ENGINE_OPTIONS);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [lastUpdateAt, setLastUpdateAt] = useState<number | null>(null);
  const tripsRef = useRef(new Map<string, PreparedTrip[]>());
  const clockOffsetRef = useRef(0);
  const clockRef = useRef(new ClockSync());
  const lastMessageRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let liveInFlight = false;
    const setClock = (serverTime: number) => {
      clockOffsetRef.current = clockRef.current.observe(serverTime);
      lastMessageRef.current = Date.now();
    };

    const loadNetwork = async () => {
      for (let attempt = 0; !cancelled; attempt++) {
        try {
          const n = await fetchNetwork();
          if (!cancelled) setNetwork(n);
          return;
        } catch (e) {
          setError(`Сеть маршрутов недоступна: ${(e as Error).message}`);
          await new Promise((r) => setTimeout(r, Math.min(30_000, 2000 * 2 ** attempt)));
        }
      }
    };

    const loadLive = async () => {
      if (liveInFlight) return;
      liveInFlight = true;
      try {
        const live = await fetchLive();
        if (cancelled) return;
        setClock(live.serverTime);
        const m = new Map<string, PreparedTrip[]>();
        for (const t of live.trips) {
          const arr = m.get(t.routeId) ?? [];
          arr.push(t);
          m.set(t.routeId, arr);
        }
        tripsRef.current = m;
        setEngine(live.engine);
        setRouteMeta(live.routes);
        setLastUpdateAt(Date.now());
        setVersion((v) => v + 1);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(`Нет данных о рейсах: ${(e as Error).message}`);
      } finally {
        liveInFlight = false;
      }
    };

    void loadNetwork();
    void loadLive();
    const close = openStream({
      onClock: setClock,
      onStatus: (ok) => {
        setConnected(ok);
        if (ok) void loadLive(); // resync after (re)connect
      },
      onNetwork: () => void loadNetwork(),
      onRoute: (e) => {
        tripsRef.current.set(e.routeId, e.trips);
        setRouteMeta((m) => ({ ...m, [e.routeId]: e.route }));
        setLastUpdateAt(Date.now());
        setVersion((v) => v + 1);
      },
    });
    // safety net in case events were missed
    const resync = setInterval(() => void loadLive(), 5 * 60_000);
    // a tab that was in the background (or a phone that was asleep) catches up at once
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastMessageRef.current > RESYNC_AFTER_MS) void loadLive();
    };
    const onOnline = () => void loadLive();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    return () => {
      cancelled = true;
      close();
      clearInterval(resync);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
    };
  }, []);

  const idx = useMemo(() => (network ? indexNetwork(network.routes, network.stops) : null), [network]);

  return { network, idx, tripsRef, routeMeta, engine, clockOffsetRef, connected, error, version, lastUpdateAt };
}

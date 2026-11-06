import { useEffect, useState } from 'react';
import { MapView, type MapFilters } from './MapView';
import { Panel } from './Panel';
import { useLiveData } from './useLiveData';

const STORAGE_KEY = 'myciti-live-map:filters:v1';

interface Stored {
  routes: string[] | null; // null = all
  showStops: boolean;
  showLines: boolean;
  highlightSuspect: boolean;
  hideSuspect: boolean;
}

function loadStored(): Stored | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Stored) : null;
  } catch {
    return null;
  }
}

function saveStored(f: MapFilters, allIds: string[]): void {
  try {
    const all = allIds.length > 0 && allIds.every((id) => f.routes.has(id));
    const s: Stored = {
      routes: all ? null : [...f.routes],
      showStops: f.showStops,
      showLines: f.showLines,
      highlightSuspect: f.highlightSuspect,
      hideSuspect: f.hideSuspect,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // storage unavailable: filters just won't persist
  }
}

export function App() {
  const data = useLiveData();
  // read once: this component re-renders every second while the map is live
  const [stored] = useState(loadStored);
  const [filters, setFiltersState] = useState<MapFilters>({
    routes: new Set(),
    showStops: stored?.showStops ?? true,
    showLines: stored?.showLines ?? true,
    highlightSuspect: stored?.highlightSuspect ?? true,
    hideSuspect: stored?.hideSuspect ?? false,
  });
  const [initialised, setInitialised] = useState(false);
  const [stats, setStats] = useState({ total: 0, suspect: 0, byRoute: {} as Record<string, number> });
  const [panelOpen, setPanelOpen] = useState(() => typeof window === 'undefined' || window.innerWidth > 720);
  const allIds = data.network?.routes.map((r) => r.id) ?? [];

  // once the network is known, select all routes (or the stored selection)
  useEffect(() => {
    if (!data.network || initialised) return;
    const ids = data.network.routes.map((r) => r.id);
    const sel = stored?.routes ? ids.filter((id) => stored.routes!.includes(id)) : ids;
    setFiltersState((f) => ({ ...f, routes: new Set(sel) }));
    setInitialised(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.network]);

  const setFilters = (f: MapFilters) => {
    setFiltersState(f);
    saveStored(f, allIds);
  };

  return (
    <div className="app">
      <MapView
        network={data.network}
        idx={data.idx}
        tripsRef={data.tripsRef}
        engine={data.engine}
        clockOffsetRef={data.clockOffsetRef}
        filters={filters}
        onStats={setStats}
      />
      <Panel
        routes={data.network?.routes ?? []}
        filters={filters}
        setFilters={setFilters}
        stats={stats}
        connected={data.connected}
        lastUpdateAt={data.lastUpdateAt}
        error={data.error}
        open={panelOpen}
        setOpen={setPanelOpen}
      />
    </div>
  );
}

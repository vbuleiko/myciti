import type { NetworkRoute } from '@myciti/shared';
import { useMemo, useState } from 'react';
import type { MapFilters } from './MapView';
import { ageText } from './format';

interface Props {
  routes: NetworkRoute[];
  filters: MapFilters;
  setFilters: (f: MapFilters) => void;
  stats: { total: number; suspect: number; byRoute: Record<string, number> };
  connected: boolean;
  lastUpdateAt: number | null;
  error: string | null;
  open: boolean;
  setOpen: (v: boolean) => void;
}

const GROUPS: { title: string; test: (id: string) => boolean }[] = [
  { title: 'Магистральные (T)', test: (id) => id.startsWith('T') },
  { title: 'Прямые (D)', test: (id) => id.startsWith('D') },
  { title: 'Центр города (1xx)', test: (id) => id.startsWith('1') },
  { title: 'Подвозящие (2xx)', test: (id) => id.startsWith('2') },
  { title: 'Другие', test: () => true },
];

const naturalCmp = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

export function Panel({ routes, filters, setFilters, stats, connected, lastUpdateAt, error, open, setOpen }: Props) {
  const [q, setQ] = useState('');
  const grouped = useMemo(() => {
    const used = new Set<string>();
    const sorted = [...routes].sort((a, b) => naturalCmp(a.id, b.id));
    return GROUPS.map((g) => {
      const items = sorted.filter((r) => !used.has(r.id) && g.test(r.id));
      items.forEach((r) => used.add(r.id));
      return { title: g.title, items };
    }).filter((g) => g.items.length);
  }, [routes]);

  const query = q.trim().toLowerCase();
  const matches = (r: NetworkRoute) =>
    !query || r.id.toLowerCase().includes(query) || r.longName.toLowerCase().includes(query);

  const toggle = (id: string) => {
    const next = new Set(filters.routes);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setFilters({ ...filters, routes: next });
  };
  const setAll = (on: boolean, ids: string[]) => {
    const next = new Set(filters.routes);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    setFilters({ ...filters, routes: next });
  };
  const visibleIds = routes.filter(matches).map((r) => r.id);
  const onlyActive = () => setFilters({ ...filters, routes: new Set(Object.keys(stats.byRoute)) });

  return (
    <aside className={`panel ${open ? 'open' : ''}`}>
      <button className="panel-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? '×' : '☰'} <span className="panel-toggle-count">{stats.total}</span>
      </button>
      <div className="panel-body">
        <header>
          <h1>
            MyCiTi Live Map <span className="tag">неофициально</span>
          </h1>
          <div className="status">
            <span className={`dot ${connected ? 'ok' : 'bad'}`} title={connected ? 'Поток обновлений подключён' : 'Нет соединения с сервером'} />
            <span>
              <b>{stats.total}</b> автобусов на карте
              {stats.suspect > 0 && <span className="muted"> · {stats.suspect} подозрительных</span>}
            </span>
          </div>
          <div className="muted small">
            {lastUpdateAt ? `Обновление данных: ${ageText(Date.now() - lastUpdateAt)}` : 'Загрузка данных…'}
          </div>
          {error && <div className="error">{error}</div>}
        </header>

        <section className="toggles">
          <label>
            <input type="checkbox" checked={filters.showStops} onChange={(e) => setFilters({ ...filters, showStops: e.target.checked })} />
            Остановки
          </label>
          <label>
            <input type="checkbox" checked={filters.showLines} onChange={(e) => setFilters({ ...filters, showLines: e.target.checked })} />
            Линии маршрутов
          </label>
          <label title="Рейсы, где живое время отличается от расписания более чем на 30 минут">
            <input
              type="checkbox"
              checked={filters.highlightSuspect}
              onChange={(e) => setFilters({ ...filters, highlightSuspect: e.target.checked })}
            />
            Выделять подозрительные (серым)
          </label>
          <label>
            <input type="checkbox" checked={filters.hideSuspect} onChange={(e) => setFilters({ ...filters, hideSuspect: e.target.checked })} />
            Скрыть подозрительные
          </label>
        </section>

        <section className="routes">
          <div className="routes-head">
            <input type="search" placeholder="Маршрут или район…" value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="btns">
              <button onClick={() => setAll(true, visibleIds)}>Все</button>
              <button onClick={() => setAll(false, visibleIds)}>Ни одного</button>
              <button onClick={onlyActive} title="Только маршруты, где сейчас есть автобусы">С автобусами</button>
            </div>
          </div>
          {grouped.map((g) => {
            const items = g.items.filter(matches);
            if (!items.length) return null;
            return (
              <div key={g.title} className="group">
                <div className="group-title">{g.title}</div>
                {items.map((r) => (
                  <label key={r.id} className="route-row" title={r.longName}>
                    <input type="checkbox" checked={filters.routes.has(r.id)} onChange={() => toggle(r.id)} />
                    <span className="chip" style={{ background: r.color, color: r.textColor }}>
                      {r.name}
                    </span>
                    <span className="route-name">{r.longName}</span>
                    <span className={`count ${stats.byRoute[r.id] ? '' : 'zero'}`}>{stats.byRoute[r.id] ?? 0}</span>
                  </label>
                ))}
              </div>
            );
          })}
        </section>

        <footer>
          <p>
            Неофициальный проект, не связан с City of Cape Town и MyCiTi. Данные принадлежат городу и берутся с{' '}
            <a href="https://www.myciti.org.za" target="_blank" rel="noopener">
              myciti.org.za
            </a>
            . <b>Позиции автобусов расчётные</b>: интерполяция по опубликованным временам прохождения остановок (точность до
            минуты), а не GPS.
          </p>
          <p>
            <a href="/api/health" target="_blank" rel="noopener">
              Состояние данных
            </a>{' '}
            ·{' '}
            <a href="https://github.com/vbuleiko/myciti" target="_blank" rel="noopener">
              Исходный код
            </a>
          </p>
        </footer>
      </div>
    </aside>
  );
}

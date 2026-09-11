import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  clearFlows,
  getInterceptState,
  getStatus,
  listFlows,
  patchInterceptRules,
} from '../api/client';
import { connectStream, type ConnectionState } from '../api/stream';
import type {
  EngineStatus,
  FlowFilters,
  FlowSummary,
  InterceptRules,
  PausedFlow,
} from '../api/types';
import { FlowTable } from '../components/FlowTable';
import { FlowDetailView } from '../components/FlowDetail';
import { FilterBar } from '../components/FilterBar';
import { InterceptPanel } from '../components/InterceptPanel';
import { matchesFilters, mergeFlow } from './proxyModel';
import { useT } from '../i18n';

const DEFAULT_RULES: InterceptRules = {
  enabled: false,
  intercept_requests: true,
  intercept_responses: false,
  host_filter: null,
};

type View = 'intercept' | 'history';

export function ProxyTab() {
  const t = useT();
  const [view, setView] = useState<View>('history');
  const [flows, setFlows] = useState<FlowSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [filters, setFilters] = useState<FlowFilters>({});
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rules, setRules] = useState<InterceptRules>(DEFAULT_RULES);
  const [queue, setQueue] = useState<PausedFlow[]>([]);

  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const reload = useCallback(async () => {
    try {
      setFlows(await listFlows(filtersRef.current));
      setError(null);
    } catch (err) {
      setError(t('proxy.engineUnreachable', { message: (err as Error).message }));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [filters, reload]);

  useEffect(() => {
    getInterceptState()
      .then((state) => {
        setRules(state.rules);
        setQueue(state.paused);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const poll = async () => {
      try {
        setStatus(await getStatus());
      } catch {
        setStatus(null);
      }
    };
    void poll();
    const id = window.setInterval(poll, 5000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(
    () =>
      connectStream({
        onState: setConnection,
        onEvent: (event) => {
          switch (event.type) {
            case 'flows.cleared':
              setFlows([]);
              setSelected(null);
              return;
            case 'intercept.rules':
              setRules(event.data);
              return;
            case 'intercept.paused':
              setQueue((prev) =>
                prev.some((p) => p.id === event.data.id)
                  ? prev
                  : [...prev, event.data],
              );
              return;
            case 'intercept.resolved':
              setQueue((prev) => prev.filter((p) => p.id !== event.data.id));
              return;
            case 'flow.request':
            case 'flow.response':
            case 'flow.error': {
              if (pausedRef.current) return;
              const flow = event.data;
              if (!matchesFilters(flow, filtersRef.current)) return;
              setFlows((prev) => mergeFlow(prev, flow));
              return;
            }
            default:
              return;
          }
        },
      }),
    [],
  );

  const onToggleIntercept = useCallback(
    async (patch: Partial<InterceptRules>) => {
      setRules((prev) => ({ ...prev, ...patch }));
      try {
        setRules(await patchInterceptRules(patch));
      } catch (err) {
        setError(
          t('proxy.interceptToggleFailed', {
            message: (err as Error).message,
          }),
        );
      }
    },
    [],
  );

  const onResolved = useCallback((id: string) => {
    setQueue((prev) => (id === '*' ? [] : prev.filter((p) => p.id !== id)));
  }, []);

  const onClear = useCallback(async () => {
    await clearFlows();
    setFlows([]);
    setSelected(null);
  }, []);

  const selectedFlow = useMemo(
    () => flows.find((f) => f.id === selected) ?? null,
    [flows, selected],
  );

  return (
    <div className="proxy-tab">
      <div className="subtabs">
        <button
          className={view === 'intercept' ? 'active' : ''}
          onClick={() => setView('intercept')}
        >
          {t('proxy.intercept')}
          {queue.length > 0 && <span className="badge">{queue.length}</span>}
        </button>
        <button
          className={view === 'history' ? 'active' : ''}
          onClick={() => setView('history')}
        >
          {t('proxy.history')}
        </button>
      </div>

      {view === 'intercept' ? (
        <InterceptPanel
          rules={rules}
          paused={queue}
          onToggle={onToggleIntercept}
          onResolved={onResolved}
        />
      ) : (
        <>
          <FilterBar
            filters={filters}
            onChange={setFilters}
            paused={paused}
            onTogglePause={() => setPaused((p) => !p)}
            onClear={onClear}
            onReload={reload}
            connection={connection}
            status={status}
            count={flows.length}
          />
          {error && <div className="banner error">{error}</div>}
          <div className="proxy-split">
            <FlowTable
              flows={flows}
              selectedId={selected}
              onSelect={setSelected}
            />
            <FlowDetailView flow={selectedFlow} />
          </div>
        </>
      )}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { clearFlows, getStatus, listFlows } from '../api/client';
import { connectStream, type ConnectionState } from '../api/stream';
import type { EngineStatus, FlowFilters, FlowSummary } from '../api/types';
import { FlowTable } from '../components/FlowTable';
import { FlowDetailView } from '../components/FlowDetail';
import { FilterBar } from '../components/FilterBar';
import { matchesFilters, mergeFlow } from './proxyModel';

export function ProxyTab() {
  const [flows, setFlows] = useState<FlowSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [filters, setFilters] = useState<FlowFilters>({});
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const reload = useCallback(async () => {
    try {
      setFlows(await listFlows(filtersRef.current));
      setError(null);
    } catch (err) {
      setError(`엔진에 연결할 수 없습니다: ${(err as Error).message}`);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [filters, reload]);

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
          if (event.type === 'flows.cleared') {
            setFlows([]);
            setSelected(null);
            return;
          }
          if (
            event.type !== 'flow.request' &&
            event.type !== 'flow.response' &&
            event.type !== 'flow.error'
          ) {
            return;
          }
          if (pausedRef.current) return;
          const flow = event.data;
          if (!matchesFilters(flow, filtersRef.current)) return;
          setFlows((prev) => mergeFlow(prev, flow));
        },
      }),
    [],
  );

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
        <FlowTable flows={flows} selectedId={selected} onSelect={setSelected} />
        <FlowDetailView flow={selectedFlow} />
      </div>
    </div>
  );
}

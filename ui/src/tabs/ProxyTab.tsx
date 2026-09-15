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
import { ContextMenu, useContextMenu } from '../components/ContextMenu';
import { flowMenuItems, flowUrl } from './flowMenu';
import { useCodegenMenu } from '../components/useCodegenMenu';
import { Split } from '../components/Split';
import { sendToRepeater } from './repeaterStore';
import { sendToIntruder } from './intruderStore';
import { addScopeFromUrl } from '../api/client';
import { FlowDetailView } from '../components/FlowDetail';
import { FilterBar } from '../components/FilterBar';
import { InterceptPanel } from '../components/InterceptPanel';
import { matchesFilters, mergeFlow } from './proxyModel';
import { msg, renderMessage, useT, type Message } from '../i18n';

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
  const codegen = useCodegenMenu();
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<Message | null>(null);
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
      setError(msg('proxy.engineUnreachable', { message: (err as Error).message }));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [filters, reload]);

  useEffect(() => {
    getInterceptState()
      .then((state) => {
        // Guard the shape: rendering reads .length on the queue, so a
        // response without it would take the whole tab down.
        if (state?.rules) setRules(state.rules);
        setQueue(state?.paused ?? []);
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
          msg('proxy.interceptToggleFailed', {
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

  const menu = useContextMenu<FlowSummary>();

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
          {error && <div className="banner error">{renderMessage(error, t)}</div>}
          <Split
            direction="horizontal"
            storageKey="lanius.split.proxy"
            initial={0.58}
            className="proxy-split"
            first={
              <FlowTable
                flows={flows}
                selectedId={selected}
                onSelect={setSelected}
                onContextMenu={menu.open}
              />
            }
            second={<FlowDetailView flow={selectedFlow} />}
          />
          <ContextMenu
            position={menu.position}
            items={
              menu.target
                ? flowMenuItems(menu.target, t, {
                    sendToRepeater: (flow) => sendToRepeater(flow),
                    sendToIntruder: (flow) => sendToIntruder(flow),
                    addToScope: (flow) => {
                      void addScopeFromUrl(flowUrl(flow)).catch(() => undefined);
                    },
                    copy: (text) => {
                      void navigator.clipboard?.writeText(text);
                    },
                  },
                  // A stored flow is rendered from its id, so the engine
                  // uses the headers and body it actually captured.
                  codegen.buildMenu({ flow_id: menu.target.id }))
                : []
            }
            onClose={menu.close}
          />
        </>
      )}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  clearFlows,
  deleteFlows,
  getFlow,
  getInterceptState,
  getStatus,
  listFlowPage,
  patchInterceptRules,
} from '../api/client';
import { connectStream, type ConnectionState } from '../api/stream';
import type {
  EngineStatus,
  FlowDetail,
  FlowFilters,
  FlowSummary,
  HistorySortKey,
  InterceptRules,
  PausedFlow,
} from '../api/types';
import { FlowTable } from '../components/FlowTable';
import { ContextMenu, useContextMenu } from '../components/ContextMenu';
import { usePluginActions } from '../components/usePluginActions';
import { flowMenuItems, flowUrl } from './flowMenu';
import { useCodegenMenu } from '../components/useCodegenMenu';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Split } from '../components/Split';
import { FilterDialog } from '../components/FilterDialog';
import {
  clearSelection,
  getSelectedFlow,
  setSelectedFlow,
  subscribe as subscribeSelection,
} from './selectionStore';
import { sendToReplay } from './replayStore';
import { sendToFuzzer } from './fuzzerStore';
import { addScopeFromUrl } from '../api/client';
import { FlowDetailView } from '../components/FlowDetail';
import { FilterBar } from '../components/FilterBar';
import { InterceptPanel } from '../components/InterceptPanel';
import { WebSocketPanel } from '../components/WebSocketPanel';
import { matchesFilters, mergeFlow } from './proxyModel';
import { msg, rawMsg, renderMessage, useT, type Message } from '../i18n';
import { useReportBusy } from '../components/busy';

const DEFAULT_RULES: InterceptRules = {
  enabled: false,
  intercept_requests: true,
  intercept_responses: false,
  host_filter: null,
};

type View = 'intercept' | 'history' | 'websockets';

export function ProxyTab() {
  const t = useT();
  const [view, setView] = useState<View>('history');
  const [flows, setFlows] = useState<FlowSummary[]>([]);
  const flowsRef = useRef(flows);
  flowsRef.current = flows;
  const [historyPage, setHistoryPage] = useState(0);
  const [historyPageInput, setHistoryPageInput] = useState('1');
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historySort, setHistorySort] = useState<{ key: HistorySortKey; desc: boolean }>({ key: 'started_at', desc: true });
  const historySortRef = useRef(historySort);
  historySortRef.current = historySort;
  // Outside the component: switching tabs unmounts this one, and a
  // selection kept here would be gone when you came back to it.
  const [selected, setSelected] = useState<string | null>(getSelectedFlow);
  useEffect(() => subscribeSelection(setSelected), []);
  const [filters, setFilters] = useState<FlowFilters>({});
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const codegen = useCodegenMenu();
  const [filterOpen, setFilterOpen] = useState(false);
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<Message | null>(null);
  const [rules, setRules] = useState<InterceptRules>(DEFAULT_RULES);
  const [queue, setQueue] = useState<PausedFlow[]>([]);

  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const historyPageRef = useRef(historyPage);
  historyPageRef.current = historyPage;
  const historyAnchor = useRef<number | undefined>(undefined);
  const historyCursors = useRef<Record<number, string>>({});
  const [nextHistoryCursor, setNextHistoryCursor] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const scopeReloadTimer = useRef<number | null>(null);
  const previousSearch = useRef(filters.search);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  // First load only: reloading as traffic arrives, or after changing a
  // filter, should not cover the table you are reading.
  const [loading, setLoading] = useState(true);
  useReportBusy('proxy', loading);

  const reload = useCallback(async () => {
    const generation = ++requestGeneration.current;
    setHistoryLoading(true);
    try {
      const page = await listFlowPage(
        filtersRef.current, historyPageRef.current * 200, 200,
        historyAnchor.current,
        historySortRef.current.key === 'started_at' && historySortRef.current.desc
          ? historyCursors.current[historyPageRef.current] : undefined,
        historySortRef.current.key, historySortRef.current.desc,
      );
      if (generation !== requestGeneration.current) return;
      historyAnchor.current = page.anchor;
      setFlows(page.items);
      setHasMoreHistory(page.has_more);
      setNextHistoryCursor(page.next_cursor ?? null);
      setError(null);
    } catch (err) {
      if (generation === requestGeneration.current) {
        setError(msg('proxy.engineUnreachable', { message: (err as Error).message }));
      }
    } finally {
      if (generation === requestGeneration.current) {
        setLoading(false);
        setHistoryLoading(false);
      }
    }
  }, [historySort]);

  const onSortHistory = (key: HistorySortKey) => {
    setHistorySort((current) => ({
      key,
      desc: current.key === key ? !current.desc : key === 'started_at',
    }));
    historyAnchor.current = undefined;
    historyCursors.current = {};
    setNextHistoryCursor(null);
    setHistoryPage(0);
  };

  useEffect(() => {
    const searchChanged = filters.search !== previousSearch.current;
    previousSearch.current = filters.search;
    if (!searchChanged) {
      void reload();
      return;
    }
    requestGeneration.current += 1;
    const timer = window.setTimeout(() => void reload(), 300);
    return () => window.clearTimeout(timer);
  }, [filters, historyPage, reload]);

  useEffect(() => setHistoryPageInput(String(historyPage + 1)), [historyPage]);

  const jumpToHistoryPage = () => {
    const page = Number(historyPageInput);
    if (Number.isSafeInteger(page) && page > 0) {
      if (page === 1) {
        historyAnchor.current = undefined;
        historyCursors.current = {};
        setNextHistoryCursor(null);
      }
      setHistoryPage(page - 1);
    }
    else setHistoryPageInput(String(historyPage + 1));
  };

  useEffect(() => () => {
    if (scopeReloadTimer.current !== null) window.clearTimeout(scopeReloadTimer.current);
  }, []);

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
              historyAnchor.current = undefined;
              historyCursors.current = {};
              setNextHistoryCursor(null);
              setFlows([]);
              setHasMoreHistory(false);
              clearSelection();
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
              if (historySortRef.current.key !== 'started_at' || !historySortRef.current.desc) {
                if (historyPageRef.current === 0) historyAnchor.current = undefined;
                if (scopeReloadTimer.current !== null) window.clearTimeout(scopeReloadTimer.current);
                scopeReloadTimer.current = window.setTimeout(() => void reload(), 500);
                return;
              }
              if (historyPageRef.current === 0) {
                historyAnchor.current = undefined;
                historyCursors.current = {};
                setNextHistoryCursor(null);
              }
              if (filtersRef.current.inScopeOnly || filtersRef.current.search) {
                if (scopeReloadTimer.current !== null) window.clearTimeout(scopeReloadTimer.current);
                scopeReloadTimer.current = window.setTimeout(() => void reload(), 500);
                return;
              }
              if (historyPageRef.current === 0
                && matchesFilters(flow, filtersRef.current)
                && flowsRef.current.length >= 200
                && !flowsRef.current.some((item) => item.id === flow.id)) {
                setHasMoreHistory(true);
              }
              setFlows((prev) => {
                if (!matchesFilters(flow, filtersRef.current)) {
                  return prev.filter((item) => item.id !== flow.id);
                }
                if (historyPageRef.current > 0 && !prev.some((item) => item.id === flow.id)) {
                  return prev;
                }
                return mergeFlow(prev, flow, 200);
              });
              return;
            }
            default:
              return;
          }
        },
      }),
    [reload],
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

  const [pendingDelete, setPendingDelete] = useState<FlowSummary | null>(null);

  const removeFlow = useCallback(
    async (flow: FlowSummary) => {
      try {
        await deleteFlows({ ids: [flow.id] });
        // Dropped locally rather than reloading: a reload would jump the
        // list back to the top and lose where the user was reading.
        setFlows((prev) => prev.filter((f) => f.id !== flow.id));
        // Only when the deleted row was the selected one. A selection
        // missing from this page usually just means it is filtered out.
        if (getSelectedFlow() === flow.id) clearSelection();
      } catch {
        // The row stays; the next refresh will show whether it went.
      }
    },
    [],
  );

  const onClear = useCallback(async () => {
    await clearFlows();
    historyAnchor.current = undefined;
    historyCursors.current = {};
    setNextHistoryCursor(null);
    setFlows([]);
    setHasMoreHistory(false);
    clearSelection();
  }, []);

  const menu = useContextMenu<FlowSummary>();
  const pluginActions = usePluginActions(
    (message) => setError(rawMsg(message)),
    () => void reload(),
  );

  /** Run an action with the flow's headers and body loaded.
   *
   * Falls through with nothing if the fetch fails, so the request still
   * opens rather than the menu silently doing nothing.
   */
  const withDetail = useCallback(
    async (flow: FlowSummary, run: (detail: FlowDetail | null) => void) => {
      try {
        run(await getFlow(flow.id, true));
      } catch {
        run(null);
      }
    },
    [],
  );

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
        <button
          className={view === 'websockets' ? 'active' : ''}
          onClick={() => setView('websockets')}
        >
          {t('proxy.websockets')}
        </button>
      </div>

      {view === 'intercept' ? (
        <InterceptPanel
          rules={rules}
          paused={queue}
          onToggle={onToggleIntercept}
          onResolved={onResolved}
        />
      ) : view === 'websockets' ? (
        <WebSocketPanel />
      ) : (
        <>
          <FilterBar
            filters={filters}
            onChange={(next) => { historyAnchor.current = undefined; historyCursors.current = {}; setNextHistoryCursor(null); setHistoryPage(0); setHistoryPageInput('1'); setFilters(next); }}
            paused={paused}
            onTogglePause={() => setPaused((p) => !p)}
            onClear={onClear}
            onReload={reload}
            connection={connection}
            status={status}
            count={flows.length}
            onOpenFilter={() => setFilterOpen(true)}
          />
          <FilterDialog
            open={filterOpen}
            filters={filters}
            onClose={() => setFilterOpen(false)}
            onApply={(next) => { setHistoryPage(0); setHistoryPageInput('1'); setFilters(next); }}
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
                searchQuery={filters.search || ''}
                selectedId={selected}
                onSelect={setSelectedFlow}
                onContextMenu={menu.open}
                sortBy={historySort.key}
                sortDesc={historySort.desc}
                onSort={onSortHistory}
              />
            }
            second={<FlowDetailView flow={selectedFlow} searchQuery={filters.search || ''} />}
          />
          <div className="history-pages">
            <button disabled={historyPage === 0 || historyLoading} onClick={() => {
              if (historyPage === 1) {
                historyAnchor.current = undefined;
                historyCursors.current = {};
                setNextHistoryCursor(null);
              }
              setHistoryPage((page) => page - 1);
            }}>{t('proxy.newerHistory')}</button>
            <label>{t('proxy.historyPageLabel')}
              <input type="number" min="1" value={historyPageInput}
                onChange={(event) => setHistoryPageInput(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') jumpToHistoryPage(); }} />
            </label>
            <button disabled={historyLoading} onClick={jumpToHistoryPage}>{t('proxy.jumpToPage')}</button>
            <button disabled={!hasMoreHistory || historyLoading} onClick={() => {
              if (nextHistoryCursor) historyCursors.current[historyPage + 1] = nextHistoryCursor;
              else delete historyCursors.current[historyPage + 1];
              setHistoryPage((page) => page + 1);
            }}>{t('proxy.olderHistory')}</button>
          </div>
          <ConfirmDialog
            open={pendingDelete !== null}
            title={t('menu.deleteFlow')}
            message={t('delete.confirmFlow')}
            confirmLabel={t('common.delete')}
            onCancel={() => setPendingDelete(null)}
            onConfirm={() => {
              const flow = pendingDelete;
              setPendingDelete(null);
              if (flow) void removeFlow(flow);
            }}
          />
          <ContextMenu
            position={menu.position}
            items={
              menu.target
                ? flowMenuItems(menu.target, t, {
                    // The table row is a summary with no headers or
                    // body, so the full flow is fetched first. Without
                    // this the request arrived in Replay as a bare
                    // request line, missing everything being tested.
                    sendToReplay: (flow) => {
                      void withDetail(flow, (detail) =>
                        sendToReplay(flow, detail),
                      );
                    },
                    sendToFuzzer: (flow) => {
                      void withDetail(flow, (detail) =>
                        sendToFuzzer(flow, detail),
                      );
                    },
                    addToScope: (flow) => {
                      void addScopeFromUrl(flowUrl(flow)).catch(() => undefined);
                    },
                    copy: (text) => {
                      void navigator.clipboard?.writeText(text);
                    },
                    deleteFlow: (flow) => setPendingDelete(flow),
                  },
                  // A stored flow is rendered from its id, so the engine
                  // uses the headers and body it actually captured.
                  codegen.buildMenu({ flow_id: menu.target.id }),
                  pluginActions.buildMenu(
                    ['history', 'flow'],
                    { flow_id: menu.target.id, flow: menu.target },
                  ))
                : []
            }
            onClose={menu.close}
          />
        </>
      )}
    </div>
  );
}

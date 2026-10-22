import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  clearFlows,
  deleteFlows,
  getReplayRequest,
  getInterceptState,
  getStatus,
  listFlowPage,
  patchFlowAnnotation,
  patchInterceptRules,
} from '../api/client';
import { connectStream, type ConnectionState } from '../api/stream';
import type {
  EngineStatus,
  FlowDetail,
  FlowFilters,
  FlowSummary,
  HistoryColor,
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
import { UndoableInput } from '../components/UndoableText';
import {
  clearSelection,
  getSelectedFlow,
  setSelectedFlow,
  subscribe as subscribeSelection,
} from './selectionStore';
import { sendToReplay } from './replayStore';
import { sendToFuzzer } from './fuzzerStore';
import { useAddRequestScopeRule } from '../components/requestScope';
import { FlowDetailView } from '../components/FlowDetail';
import { copyTextToClipboard } from '../clipboard';
import { FilterBar, type HistoryLayout } from '../components/FilterBar';
import { InterceptPanel } from '../components/InterceptPanel';
import { WebSocketPanel } from '../components/WebSocketPanel';
import { matchesFilters, mergeFlow } from './proxyModel';
import { msg, rawMsg, renderMessage, useT, type Message } from '../i18n';
import { useReportBusy } from '../components/busy';
import { Busy } from '../components/Spinner';
import { useToast } from '../components/Toast';
import { scheduleLargeTextViewPreload } from '../components/largeTextViewLoader';

const DEFAULT_RULES: InterceptRules = {
  enabled: false,
  intercept_requests: true,
  intercept_responses: false,
  host_filter: null,
};

type View = 'intercept' | 'history' | 'websockets';

const HISTORY_LAYOUT_STORAGE_KEY = 'lanius.layout.proxyHistory';

function loadHistoryLayout(): HistoryLayout {
  if (typeof window === 'undefined') return 'side-by-side';
  return window.localStorage?.getItem(HISTORY_LAYOUT_STORAGE_KEY) === 'stacked'
    ? 'stacked'
    : 'side-by-side';
}

export function ProxyTab({ methodFilterRequest }: { methodFilterRequest?: { method: string } | null }) {
  const t = useT();
  const { showToast } = useToast();
  const addRequestScopeRule = useAddRequestScopeRule();
  const [view, setView] = useState<View>('history');
  const [historyLayout, setHistoryLayout] = useState<HistoryLayout>(loadHistoryLayout);
  const [flows, setFlows] = useState<FlowSummary[]>([]);
  const flowsRef = useRef(flows);
  flowsRef.current = flows;
  const [historyPage, setHistoryPage] = useState(0);
  const [historyPageInput, setHistoryPageInput] = useState('1');
  const [historyPageSize, setHistoryPageSize] = useState(200);
  const historyPageSizeRef = useRef(historyPageSize);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [queryLoading, setQueryLoading] = useState(false);
  const [historySort, setHistorySort] = useState<{ key: HistorySortKey; desc: boolean }>({ key: 'started_at', desc: true });
  const historySortRef = useRef(historySort);
  historySortRef.current = historySort;
  // Shared with actions in other tabs; the selection also survives while
  // Proxy's effects are paused in the hidden workspace tab.
  const [selected, setSelected] = useState<string | null>(getSelectedFlow);
  useEffect(() => subscribeSelection(setSelected), []);
  const [filters, setFilters] = useState<FlowFilters>({});
  const [interceptFilters, setInterceptFilters] = useState<FlowFilters>({});
  const appliedMethodRequest = useRef<typeof methodFilterRequest>(null);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const codegen = useCodegenMenu();
  const [filterOpen, setFilterOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<Message | null>(null);
  const [rules, setRules] = useState<InterceptRules>(DEFAULT_RULES);
  const [queue, setQueue] = useState<PausedFlow[]>([]);
  // The Intercept panel unmounts when switching Proxy subtabs; keep edits
  // here so returning to a held message does not discard its draft.
  const [interceptDrafts, setInterceptDrafts] = useState<Record<string, string>>({});
  const [interceptSelectedId, setInterceptSelectedId] = useState<string | null>(null);

  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const historyPageRef = useRef(historyPage);
  historyPageRef.current = historyPage;
  const historyAnchor = useRef<number | undefined>(undefined);
  const historyCursors = useRef<Record<number, string>>({});
  const [nextHistoryCursor, setNextHistoryCursor] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const historyRequest = useRef<AbortController | null>(null);
  const pendingSearchNotification = useRef<string | null>(null);
  // State changes are reloaded by the effect below, so remember when the
  // change came from a person interacting with history. Background
  // flow events must not start progress on their own.
  const nextReloadShowsProgress = useRef(false);
  const searchReloadTimer = useRef<number | null>(null);
  const scopeReloadTimer = useRef<number | null>(null);
  const backgroundReloadPending = useRef(false);
  const previousSearch = useRef(filters.search);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  // Only the first load reports busy to the workspace. User queries show
  // progress over the list; background traffic stays unobtrusive.
  const [loading, setLoading] = useState(true);
  useReportBusy('proxy', loading);

  useEffect(() => {
    if (view !== 'history' || loading) return;
    return scheduleLargeTextViewPreload();
  }, [view, loading]);

  const invalidateHistoryRequest = useCallback(() => {
    requestGeneration.current += 1;
    historyRequest.current?.abort();
    historyRequest.current = null;
  }, []);

  const prepareHistoryReload = () => {
    invalidateHistoryRequest();
    pendingSearchNotification.current = null;
    nextReloadShowsProgress.current = true;
  };

  const reload = useCallback(async ({ showProgress = false, background = false } = {}) => {
    // A scheduled search already includes incoming traffic. A background
    // response must not settle progress before that search has even started.
    if (searchReloadTimer.current !== null) {
      if (!showProgress) return;
      window.clearTimeout(searchReloadTimer.current);
      searchReloadTimer.current = null;
    }
    // Let a slow query finish even when capture produces events faster than
    // it can run. Coalesce those events into one refresh after completion.
    if (background && historyRequest.current) {
      backgroundReloadPending.current = true;
      return;
    }
    backgroundReloadPending.current = false;
    if (background && historyPageRef.current === 0) {
      historyAnchor.current = undefined;
      historyCursors.current = {};
    }
    invalidateHistoryRequest();
    const generation = requestGeneration.current;
    const controller = new AbortController();
    historyRequest.current = controller;
    const searchKey = JSON.stringify([filtersRef.current, historyPageRef.current, historyPageSizeRef.current, historySortRef.current]);
    if (showProgress && filtersRef.current.search?.trim()) pendingSearchNotification.current = searchKey;
    if (showProgress) setQueryLoading(true);
    setHistoryLoading(true);
    try {
      const page = await listFlowPage(
        filtersRef.current, historyPageRef.current * historyPageSizeRef.current, historyPageSizeRef.current,
        historyAnchor.current,
        historySortRef.current.key === 'started_at' && historySortRef.current.desc
          ? historyCursors.current[historyPageRef.current] : undefined,
        historySortRef.current.key, historySortRef.current.desc,
        controller.signal,
      );
      if (generation !== requestGeneration.current) return;
      historyAnchor.current = page.anchor;
      setFlows(page.items);
      setHasMoreHistory(page.has_more);
      setNextHistoryCursor(page.next_cursor ?? null);
      setError(null);
      if (pendingSearchNotification.current === searchKey) {
        pendingSearchNotification.current = null;
        showToast({ message: t(!page.items.length && historyPageRef.current === 0 ? 'toast.searchEmpty' : 'toast.searchCompleted'),
          tone: 'success', category: 'search', id: 'search:proxy' });
      }
    } catch (err) {
      if (generation === requestGeneration.current) {
        pendingSearchNotification.current = null;
        setError(msg('proxy.engineUnreachable', { message: (err as Error).message }));
      }
    } finally {
      if (generation === requestGeneration.current) {
        historyRequest.current = null;
        setLoading(false);
        setHistoryLoading(false);
        setQueryLoading(false);
        if (backgroundReloadPending.current && scopeReloadTimer.current === null) {
          scopeReloadTimer.current = window.setTimeout(() => {
            scopeReloadTimer.current = null;
            void reload({ background: true });
          }, 500);
        }
      }
    }
  }, [historySort, invalidateHistoryRequest, showToast, t]);

  const onSortHistory = (key: HistorySortKey) => {
    prepareHistoryReload();
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
    const showProgress = nextReloadShowsProgress.current;
    nextReloadShowsProgress.current = false;
    if (!searchChanged) {
      void reload({ showProgress });
      return;
    }
    invalidateHistoryRequest();
    pendingSearchNotification.current = null;
    const timer = window.setTimeout(
      () => {
        searchReloadTimer.current = null;
        void reload({ showProgress: true });
      },
      300,
    );
    searchReloadTimer.current = timer;
    return () => {
      window.clearTimeout(timer);
      if (searchReloadTimer.current === timer) searchReloadTimer.current = null;
    };
  }, [filters, historyPage, historyPageSize, invalidateHistoryRequest, reload]);

  useEffect(() => {
    if (!methodFilterRequest || methodFilterRequest === appliedMethodRequest.current) return;
    appliedMethodRequest.current = methodFilterRequest;
    const nextFilters = { methods: [methodFilterRequest.method] };
    invalidateHistoryRequest();
    pendingSearchNotification.current = null;
    nextReloadShowsProgress.current = true;
    filtersRef.current = nextFilters;
    historyAnchor.current = undefined;
    historyCursors.current = {};
    setNextHistoryCursor(null);
    setHistoryPage(0);
    setHistoryPageInput('1');
    setFlows([]);
    setFilters(nextFilters);
    setFilterOpen(false);
    setView('history');
  }, [invalidateHistoryRequest, methodFilterRequest]);

  useEffect(() => setHistoryPageInput(String(historyPage + 1)), [historyPage]);

  const jumpToHistoryPage = () => {
    const page = Number(historyPageInput);
    if (Number.isSafeInteger(page) && page > 0) {
      const nextPage = page - 1;
      if (nextPage === historyPageRef.current) return;
      prepareHistoryReload();
      if (page === 1) {
        historyAnchor.current = undefined;
        historyCursors.current = {};
        setNextHistoryCursor(null);
      }
      setHistoryPage(nextPage);
    }
    else setHistoryPageInput(String(historyPage + 1));
  };

  const changeHistoryPageSize = (size: number) => {
    if (size === historyPageSizeRef.current) return;
    prepareHistoryReload();
    historyPageSizeRef.current = size;
    historyPageRef.current = 0;
    historyAnchor.current = undefined;
    historyCursors.current = {};
    setNextHistoryCursor(null);
    setHistoryPage(0);
    setHistoryPageInput('1');
    setHistoryPageSize(size);
    setFlows((previous) => previous.slice(0, size));
  };

  useEffect(() => () => {
    if (scopeReloadTimer.current !== null) window.clearTimeout(scopeReloadTimer.current);
    invalidateHistoryRequest();
  }, [invalidateHistoryRequest]);

  // At most one reload per 500 ms while flows keep arriving. Restarting the
  // timer on every event would starve it under steady traffic.
  const scheduleReload = () => {
    if (scopeReloadTimer.current !== null) return;
    scopeReloadTimer.current = window.setTimeout(() => {
      scopeReloadTimer.current = null;
      void reload({ background: true });
    }, 500);
  };

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
            case 'project.imported':
              historyAnchor.current = undefined;
              historyCursors.current = {};
              historyPageRef.current = 0;
              setNextHistoryCursor(null);
              setHistoryPage(0);
              setHistoryPageInput('1');
              setFlows([]);
              clearSelection();
              void reload();
              return;
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
              setInterceptDrafts((prev) => Object.fromEntries(
                Object.entries(prev).filter(([key]) => !key.startsWith(`${event.data.id}:`)),
              ));
              return;
            case 'scope.changed':
              void getInterceptState().then((state) => setQueue((previous) => {
                const byId = new Map((state.paused ?? []).map((item) => [item.id, item]));
                return previous.map((item) => {
                  const refreshed = byId.get(item.id);
                  return refreshed ? { ...item, in_scope: refreshed.in_scope } : item;
                });
              }))
                .catch(() => undefined);
              return;
            case 'flow.annotation':
              setFlows((prev) => prev.map((item) => item.id === event.data.id
                ? { ...item, ...event.data } : item));
              setQueue((prev) => prev.map((item) => item.id === event.data.id
                ? { ...item, ...event.data } : item));
              if (filtersRef.current.bookmarkedOnly || filtersRef.current.annotationColor) void reload();
              return;
            case 'flow.request':
            case 'flow.response':
            case 'flow.error': {
              if (pausedRef.current) return;
              const flow = event.data;
              if (historySortRef.current.key !== 'started_at' || !historySortRef.current.desc) {
                if (historyPageRef.current === 0) historyAnchor.current = undefined;
                scheduleReload();
                return;
              }
              if (historyPageRef.current === 0) {
                historyAnchor.current = undefined;
                historyCursors.current = {};
                setNextHistoryCursor(null);
              }
              if (filtersRef.current.inScopeOnly || filtersRef.current.search) {
                scheduleReload();
                return;
              }
              const existing = flowsRef.current.find((item) => item.id === flow.id);
              const current = existing ? { ...existing, ...flow } : flow;
              if (historyPageRef.current === 0
                && matchesFilters(current, filtersRef.current)
                && flowsRef.current.length >= historyPageSizeRef.current
                && !flowsRef.current.some((item) => item.id === flow.id)) {
                setHasMoreHistory(true);
              }
              setFlows((prev) => {
                if (!matchesFilters(current, filtersRef.current)) {
                  return prev.filter((item) => item.id !== flow.id);
                }
                if (historyPageRef.current > 0 && !prev.some((item) => item.id === flow.id)) {
                  return prev;
                }
                return mergeFlow(prev, current, historyPageSizeRef.current);
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

  const updateAnnotation = useCallback(async (
    flow: FlowSummary, changes: { bookmarked?: boolean; annotation_color?: HistoryColor | null },
  ) => {
    try {
      const annotation = await patchFlowAnnotation(flow.id, changes);
      setFlows((prev) => prev.map((item) => item.id === flow.id ? { ...item, ...annotation } : item));
      if (filtersRef.current.bookmarkedOnly || filtersRef.current.annotationColor) void reload();
    } catch (err) {
      setError(rawMsg((err as Error).message));
    }
  }, [reload]);

  const toggleBookmark = useCallback((flow: FlowSummary) => {
    // The default highlight is part of bookmarking from the UI. Clearing
    // the bookmark must therefore clear that highlight as well; users can
    // still apply a standalone highlight from the row context menu.
    void updateAnnotation(flow, flow.bookmarked
      ? { bookmarked: false, annotation_color: null }
      : { bookmarked: true });
  }, [updateAnnotation]);

  const onClear = useCallback(async () => {
    setConfirmClear(false);
    setClearing(true);
    try {
      await clearFlows();
      invalidateHistoryRequest();
      pendingSearchNotification.current = null;
      setHistoryLoading(false);
      setQueryLoading(false);
      historyAnchor.current = undefined;
      historyCursors.current = {};
      setNextHistoryCursor(null);
      setHistoryPage(0);
      setHistoryPageInput('1');
      setFlows([]);
      setHasMoreHistory(false);
      clearSelection();
      setError(null);
      showToast({ message: t('proxy.cleared'), tone: 'success', category: 'history' });
    } catch (err) {
      showToast({
        message: t('proxy.clearFailed', { message: (err as Error).message }),
        tone: 'error',
      });
    } finally {
      setClearing(false);
    }
  }, [invalidateHistoryRequest, showToast, t]);

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
        run(await getReplayRequest(flow.id, true));
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

  const applyHistoryFilters = (next: FlowFilters) => {
    if (next === filtersRef.current && historyPageRef.current === 0) return;
    prepareHistoryReload();
    historyAnchor.current = undefined;
    historyCursors.current = {};
    setNextHistoryCursor(null);
    setHistoryPage(0);
    setHistoryPageInput('1');
    setFilters(next);
  };

  const toggleHistoryLayout = () => {
    setHistoryLayout((current) => {
      const next = current === 'side-by-side' ? 'stacked' : 'side-by-side';
      window.localStorage?.setItem(HISTORY_LAYOUT_STORAGE_KEY, next);
      return next;
    });
  };

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
          drafts={interceptDrafts}
          onDraftsChange={setInterceptDrafts}
          selectedId={interceptSelectedId}
          onSelectedChange={setInterceptSelectedId}
          filters={interceptFilters}
          onFiltersChange={setInterceptFilters}
        />
      ) : view === 'websockets' ? (
        <WebSocketPanel />
      ) : (
        <>
          <FilterBar
            filters={filters}
            onChange={applyHistoryFilters}
            paused={paused}
            onTogglePause={() => setPaused((p) => !p)}
            onClear={() => setConfirmClear(true)}
            clearBusy={clearing}
            onReload={() => void reload({ showProgress: true })}
            connection={connection}
            status={status}
            count={flows.length}
            historyPageSize={historyPageSize}
            onHistoryPageSizeChange={changeHistoryPageSize}
            onOpenFilter={() => setFilterOpen(true)}
            historyLayout={historyLayout}
            onToggleHistoryLayout={toggleHistoryLayout}
          />
          <FilterDialog
            open={filterOpen}
            filters={filters}
            onClose={() => setFilterOpen(false)}
            onApply={applyHistoryFilters}
          />
          {error && <div className="banner error">{renderMessage(error, t)}</div>}
          <Split
            direction={historyLayout === 'side-by-side' ? 'horizontal' : 'vertical'}
            storageKey={historyLayout === 'side-by-side'
              ? 'lanius.split.proxy'
              : 'lanius.split.proxy.stacked'}
            initial={historyLayout === 'side-by-side' ? 0.58 : 0.45}
            className="proxy-split"
            first={
              <Busy busy={queryLoading} label={t('proxy.searching')}>
                <FlowTable
                  flows={flows}
                  searchQuery={filters.search || ''}
                  selectedId={selected}
                  onSelect={setSelectedFlow}
                  onContextMenu={menu.open}
                  sortBy={historySort.key}
                  sortDesc={historySort.desc}
                  onSort={onSortHistory}
                  onToggleBookmark={toggleBookmark}
                  proxyAddress={status ? `${status.proxy.host}:${status.proxy.port}` : undefined}
                />
              </Busy>
            }
            second={<FlowDetailView flow={selectedFlow} searchQuery={filters.search || ''} inspector />}
          />
          <div className="history-pages">
            <button disabled={historyPage === 0 || historyLoading} onClick={() => {
              prepareHistoryReload();
              if (historyPage === 1) {
                historyAnchor.current = undefined;
                historyCursors.current = {};
                setNextHistoryCursor(null);
              }
              setHistoryPage((page) => page - 1);
            }}>{t('proxy.newerHistory')}</button>
            <label>{t('proxy.historyPageLabel')}
              <UndoableInput type="number" min="1" value={historyPageInput}
                onValueChange={setHistoryPageInput}
                onKeyDown={(event) => { if (event.key === 'Enter') jumpToHistoryPage(); }} />
            </label>
            <button disabled={historyLoading} onClick={jumpToHistoryPage}>{t('proxy.jumpToPage')}</button>
            <button disabled={!hasMoreHistory || historyLoading} onClick={() => {
              prepareHistoryReload();
              if (nextHistoryCursor) historyCursors.current[historyPage + 1] = nextHistoryCursor;
              else delete historyCursors.current[historyPage + 1];
              setHistoryPage((page) => page + 1);
            }}>{t('proxy.olderHistory')}</button>
          </div>
          <ConfirmDialog
            open={confirmClear}
            title={t('proxy.clearConfirmTitle')}
            message={t('proxy.clearConfirmMessage')}
            confirmLabel={t('common.clear')}
            onCancel={() => setConfirmClear(false)}
            onConfirm={() => void onClear()}
          />
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
                    addScopeRule: (flow, kind, target) => {
                      void addRequestScopeRule(flowUrl(flow), kind, target);
                    },
                    copy: copyTextToClipboard,
                    deleteFlow: (flow) => setPendingDelete(flow),
                    toggleBookmark,
                    setColor: (flow, color) => void updateAnnotation(flow, { annotation_color: color }),
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

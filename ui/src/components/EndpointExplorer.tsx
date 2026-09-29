import { useEffect, useMemo, useRef, useState } from 'react';

import { addScopeFromUrl, deleteFlows, getEndpointFlows, getFlow } from '../api/client';
import type { EndpointGroup, FlowDetail, SitePath } from '../api/types';
import { formatBytes, formatTime, formatUrl } from '../tabs/proxyModel';
import { endpointHost } from '../tabs/targetModel';
import { sendToRepeater } from '../tabs/repeaterStore';
import { sendToIntruder } from '../tabs/intruderStore';
import { renderMessage, useT } from '../i18n';
import { ContextMenu, useContextMenu, type MenuItem } from './ContextMenu';
import { ConfirmDialog } from './ConfirmDialog';
import { FlowDetailView } from './FlowDetail';
import { ResizableFillCell, ResizableFillHeader, ResizableHeader, ResizableTable, useResizableColumns } from './ResizableColumns';
import { Split } from './Split';
import { useCodegenMenu } from './useCodegenMenu';

const PAGE_SIZE = 200;

export function EndpointExplorer({
  endpoints,
  inScopeOnly,
  onChanged,
}: {
  endpoints: EndpointGroup[];
  inScopeOnly: boolean;
  onChanged: () => Promise<void>;
}) {
  const t = useT();
  const endpointColumns = useResizableColumns('lanius.columns.endpoints', [70, 180, 300, 78, 180, 180]);
  const requestColumns = useResizableColumns('lanius.columns.endpointRequests', [90, 360, 75, 90]);
  const [endpointKey, setEndpointKey] = useState<string | null>(null);
  const endpoint = useMemo(() => endpoints.find((item) => item.key === endpointKey) ?? null, [endpoints, endpointKey]);
  const [requests, setRequests] = useState<SitePath[]>([]);
  const [requestCount, setRequestCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<FlowDetail | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SitePath | null>(null);
  const [error, setError] = useState<string | null>(null);
  const menu = useContextMenu<SitePath>();
  const codegen = useCodegenMenu((message) => setError(renderMessage(message, t)));
  const queryRef = useRef('');

  useEffect(() => {
    queryRef.current = `${endpointKey}:${inScopeOnly}`;
    setRequests([]);
    setRequestCount(0);
    setSelectedRequestId(null);
    setSelectedDetail(null);
  }, [endpointKey, inScopeOnly]);

  useEffect(() => {
    if (!endpoint) {
      setRequests([]);
      setRequestCount(0);
      setSelectedRequestId(null);
      setSelectedDetail(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    getEndpointFlows(endpoint, inScopeOnly, PAGE_SIZE)
      .then(({ items, count }) => {
        if (cancelled) return;
        setRequests(items);
        setRequestCount(count);
        setError(null);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [endpoint, inScopeOnly]);

  useEffect(() => {
    if (!selectedRequestId) {
      setSelectedDetail(null);
      return;
    }
    let cancelled = false;
    getFlow(selectedRequestId)
      .then((detail) => { if (!cancelled) setSelectedDetail(detail); })
      .catch((err: Error) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [selectedRequestId]);

  const loadMore = async () => {
    if (!endpoint || loadingMore || requests.length >= requestCount) return;
    const query = queryRef.current;
    setLoadingMore(true);
    try {
      const { items, count } = await getEndpointFlows(endpoint, inScopeOnly, PAGE_SIZE, requests.length);
      if (queryRef.current !== query) return;
      setRequests((current) => [...current, ...items]);
      setRequestCount(count);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingMore(false);
    }
  };

  const withDetail = (request: SitePath, action: (detail: FlowDetail) => void) => () => {
    void getFlow(request.id, true)
      .then(action)
      .catch((err: Error) => setError(err.message));
  };

  const selectRequest = (id: string) => {
    if (id !== selectedRequestId) setSelectedDetail(null);
    setSelectedRequestId(id);
  };

  const menuItems: MenuItem[] = menu.target ? [
    { label: t('menu.sendToRepeater'), onSelect: withDetail(menu.target, (detail) => sendToRepeater(detail, detail)) },
    { label: t('menu.sendToIntruder'), onSelect: withDetail(menu.target, (detail) => sendToIntruder(detail, detail)) },
    {
      label: t('menu.addToScope'),
      separator: true,
      onSelect: withDetail(menu.target, (detail) => {
        void addScopeFromUrl(formatUrl(detail)).then(onChanged).catch((err: Error) => setError(err.message));
      }),
    },
    {
      label: t('menu.copyUrl'),
      onSelect: withDetail(menu.target, (detail) => {
        void navigator.clipboard?.writeText(formatUrl(detail));
      }),
    },
    codegen.buildMenu({ flow_id: menu.target.id }),
    { label: t('menu.deleteFlow'), separator: true, danger: true, onSelect: () => setPendingDelete(menu.target) },
  ] : [];

  const deleteRequest = async () => {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    setPendingDelete(null);
    try {
      await deleteFlows({ ids: [id] });
      if (selectedRequestId === id) {
        setSelectedRequestId(null);
        setSelectedDetail(null);
      }
      setRequests((current) => current.filter((item) => item.id !== id));
      setRequestCount((count) => Math.max(0, count - 1));
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return <>
    <Split
      direction="vertical"
      storageKey="lanius.split.endpoints.vertical"
      initial={0.36}
      className="endpoint-layout"
      first={<div className="endpoint-list">
        <ResizableTable columns={endpointColumns} className="flow-table">
          <thead><tr>
            {[
              t('flow.method'), t('flow.host'), t('target.endpoint'),
              t('target.count'), t('target.params'), t('target.statuses'),
            ].map((label, index) => (
              <ResizableHeader key={index} label={label} index={index} columns={endpointColumns} resizeLabel={t('table.resizeColumn', { column: label })} />
            ))}
            <ResizableFillHeader />
          </tr></thead>
          <tbody>
            {endpoints.length === 0 && <tr><td colSpan={6} className="empty">{t('target.noEndpoints')}</td><ResizableFillCell /></tr>}
            {endpoints.map((item) => (
              <tr key={item.key} className={item.key === endpointKey ? 'selected' : ''} onClick={() => setEndpointKey(item.key)}>
                <td className="mono">{item.method}</td>
                <td className="mono">{endpointHost(item)}</td>
                <td className="mono">{item.template}</td>
                <td className="mono num">{item.count}</td>
                <td className="mono">{item.query_params.map((param) => <span key={param} className="param">{param}</span>)}</td>
                <td className="mono">{item.statuses.join(', ')}</td>
                <ResizableFillCell />
              </tr>
            ))}
          </tbody>
        </ResizableTable>
      </div>}
      second={endpoint ? <Split
        direction="horizontal"
        storageKey="lanius.split.endpoints.requests"
        initial={0.48}
        className="endpoint-request-split"
        first={<div className="endpoint-requests">
          <div className="endpoint-request-heading">
            <strong className="mono" title={`${endpointHost(endpoint)}${endpoint.template}`}>{endpoint.method} {endpoint.template}</strong>
            <span className="muted">{t('target.requestCount', { count: requestCount })}</span>
          </div>
          {error && <div className="banner error">{error}</div>}
          <div className="endpoint-request-list">
            <ResizableTable columns={requestColumns} className="flow-table">
              <thead><tr>
                {[t('flow.time'), t('flow.url'), t('flow.status'), t('flow.size')].map((label, index) => (
                  <ResizableHeader key={index} label={label} index={index} columns={requestColumns} resizeLabel={t('table.resizeColumn', { column: label })} />
                ))}
                <ResizableFillHeader />
              </tr></thead>
              <tbody>
                {!loading && requests.length === 0 && <tr><td colSpan={4} className="empty">{t('target.noEndpointRequests')}</td><ResizableFillCell /></tr>}
                {requests.map((request) => (
                  <tr key={request.id} className={request.id === selectedRequestId ? 'selected' : ''}
                    onClick={() => selectRequest(request.id)}
                    onContextMenu={(event) => { selectRequest(request.id); menu.open(event, request); }}>
                    <td className="mono">{formatTime(request.started_at)}</td>
                    <td className="mono" title={`${request.path}${request.query ? `?${request.query}` : ''}`}>{request.path}{request.query ? `?${request.query}` : ''}</td>
                    <td className="mono num">{request.status_code ?? '—'}</td>
                    <td className="mono num">{formatBytes(request.response_size)}</td>
                    <ResizableFillCell />
                  </tr>
                ))}
              </tbody>
            </ResizableTable>
            {loading && <p className="muted endpoint-loading">{t('common.loading')}…</p>}
          </div>
          {requests.length < requestCount && <button className="endpoint-load-more" disabled={loadingMore} onClick={() => void loadMore()}>{t('target.loadMoreRequests')}</button>}
        </div>}
        second={<div className="site-detail"><FlowDetailView flow={selectedDetail} splitStorageKey="lanius.split.endpoints.detail" initialSplit={0.35} /></div>}
      /> : <div className="endpoint-prompt muted">{t('target.selectEndpoint')}</div>}
    />
    <ContextMenu position={menu.position} items={menuItems} onClose={menu.close} />
    <ConfirmDialog open={pendingDelete !== null} title={t('menu.deleteFlow')} message={t('delete.confirmFlow')} confirmLabel={t('common.delete')} onCancel={() => setPendingDelete(null)} onConfirm={() => void deleteRequest()} />
  </>;
}

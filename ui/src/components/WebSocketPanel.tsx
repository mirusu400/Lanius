import { useEffect, useMemo, useState } from 'react';

import {
  clearWebSocketMessages,
  dropWebSocketMessage,
  forwardWebSocketMessage,
  getWebSocketState,
  listWebSocketMessages,
  patchWebSocketIntercept,
  repeatWebSocketMessage,
} from '../api/client';
import { connectStream } from '../api/stream';
import type {
  WebSocketConnection,
  WebSocketInterceptRules,
  WebSocketMessage,
} from '../api/types';
import { errorMessage, renderMessage, useT, type Message } from '../i18n';
import { ResizableFillCell, ResizableFillHeader, ResizableHeader, ResizableTable, useResizableColumns } from './ResizableColumns';
import { Split } from './Split';

const DEFAULT_RULES: WebSocketInterceptRules = {
  enabled: false,
  client_messages: true,
  server_messages: true,
};

export function WebSocketPanel() {
  const t = useT();
  const columns = useResizableColumns('lanius.columns.websocket', [110, 300, 80, 100]);
  const [rules, setRules] = useState(DEFAULT_RULES);
  const [connections, setConnections] = useState<WebSocketConnection[]>([]);
  const [messages, setMessages] = useState<WebSocketMessage[]>([]);
  const [page, setPage] = useState(0);
  const [pageStarts, setPageStarts] = useState<(number | undefined)[]>([undefined]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [pageLoading, setPageLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [toClient, setToClient] = useState(false);
  const [error, setError] = useState<Message | null>(null);
  const selected = useMemo(
    () => messages.find((message) => message.id === selectedId) ?? null,
    [messages, selectedId],
  );
  const active = selected
    ? connections.some((connection) => connection.id === selected.connection_id && connection.active)
    : false;

  useEffect(() => {
    getWebSocketState()
      .then((state) => {
        setRules(state.rules ?? DEFAULT_RULES);
        setConnections(state.connections ?? []);
        setMessages([...(state.messages ?? [])].reverse());
        setHasMore(state.has_more ?? false);
        setNextBefore(state.next_before ?? null);
      })
      .catch((err) => setError(errorMessage(err)));
  }, []);

  useEffect(() => {
    if (!selected) return;
    setContent(selected.content);
    setToClient(!selected.from_client);
  }, [selected]);

  useEffect(
    () =>
      connectStream({
        onEvent: (event) => {
          switch (event.type) {
            case 'websocket.started':
            case 'websocket.ended':
              setConnections((current) => [
                event.data,
                ...current.filter((item) => item.id !== event.data.id),
              ]);
              return;
            case 'websocket.message':
            case 'websocket.intercepted':
              if (page === 0) {
                setMessages((current) => {
                  const next = [event.data, ...current.filter((item) => item.id !== event.data.id)].slice(0, 200);
                  if (current.length >= 200) setHasMore(true);
                  setNextBefore((before) => next.at(-1)?.seq ?? before);
                  return next;
                });
                setSelectedId((id) => id ?? event.data.id);
              }
              return;
            case 'websocket.resolved':
              setMessages((current) =>
                current.map((message) =>
                  message.id === event.data.id
                    ? {
                        ...message,
                        paused: false,
                        dropped: event.data.action === 'drop',
                      }
                    : message,
                ),
              );
              return;
            case 'websocket.rules':
              setRules(event.data);
              return;
            case 'websocket.cleared':
              setMessages([]);
              setSelectedId(null);
              setPage(0);
              setPageStarts([undefined]);
              setNextBefore(null);
              setHasMore(false);
              return;
            default:
              return;
          }
        },
      }),
    [page],
  );

  const loadPage = async (start: number | undefined, target: number) => {
    setPageLoading(true);
    try {
      const result = await listWebSocketMessages(start);
      setMessages(result.items);
      setHasMore(result.has_more);
      setNextBefore(result.next_before);
      setPage(target);
      setSelectedId(result.items[0]?.id ?? null);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPageLoading(false);
    }
  };

  const older = () => {
    if (nextBefore === null) return;
    const starts = pageStarts.slice(0, page + 1);
    starts.push(nextBefore);
    setPageStarts(starts);
    void loadPage(nextBefore, page + 1);
  };

  const newer = () => {
    if (page === 0) return;
    void loadPage(pageStarts[page - 1], page - 1);
  };

  const patchRules = async (patch: Partial<WebSocketInterceptRules>) => {
    setRules((current) => ({ ...current, ...patch }));
    try {
      setRules(await patchWebSocketIntercept(patch));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const forward = async () => {
    if (!selected) return;
    try {
      await forwardWebSocketMessage(selected.id, content, selected.encoding);
      setMessages((current) => current.map((item) => item.id === selected.id ? { ...item, content, paused: false } : item));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const drop = async () => {
    if (!selected) return;
    try {
      await dropWebSocketMessage(selected.id);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const repeat = async () => {
    if (!selected) return;
    try {
      await repeatWebSocketMessage({
        connection_id: selected.connection_id,
        to_client: toClient,
        content,
        encoding: selected.encoding,
        is_text: selected.is_text,
      });
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div className="websocket-panel">
      <div className="websocket-controls">
        <button
          type="button"
          className={rules.enabled ? 'toggle on' : 'toggle'}
          onClick={() => void patchRules({ enabled: !rules.enabled })}
        >
          {rules.enabled ? t('websocket.interceptOn') : t('websocket.interceptOff')}
        </button>
        <label><input type="checkbox" checked={rules.client_messages} onChange={(event) => void patchRules({ client_messages: event.target.checked })} />{t('websocket.clientMessages')}</label>
        <label><input type="checkbox" checked={rules.server_messages} onChange={(event) => void patchRules({ server_messages: event.target.checked })} />{t('websocket.serverMessages')}</label>
        <span className="spacer" />
        <span className="muted">{t('websocket.active', { count: connections.filter((item) => item.active).length })}</span>
        <button type="button" onClick={() => void clearWebSocketMessages()}>{t('common.clear')}</button>
      </div>
      {error && <div className="banner error">{renderMessage(error, t)}</div>}
      <Split
        direction="horizontal"
        storageKey="lanius.split.websocket"
        className="websocket-split"
        first={<div className="websocket-list">
          <ResizableTable columns={columns} className="websocket-table">
            <thead><tr>
              {[t('websocket.direction'), t('flow.host'), t('flow.size'), t('common.status')].map((label, index) => (
                <ResizableHeader key={index} label={label} index={index} columns={columns} resizeLabel={t('table.resizeColumn', { column: label })} />
              ))}
              <ResizableFillHeader />
            </tr></thead>
            <tbody>
              {messages.map((message) => (
                <tr key={message.id} className={message.id === selectedId ? 'selected' : undefined} onClick={() => setSelectedId(message.id)}>
                  <td>{message.from_client ? t('detail.toServer') : t('detail.toClient')}</td>
                  <td className="mono">{message.host}{message.path}</td>
                  <td>{message.size}</td>
                  <td>{message.paused ? t('websocket.held') : message.dropped ? t('websocket.dropped') : message.injected ? t('websocket.repeated') : ''}</td>
                  <ResizableFillCell />
                </tr>
              ))}
            </tbody>
          </ResizableTable>
          {messages.length === 0 && <p className="muted websocket-empty">{t('websocket.empty')}</p>}
          <div className="history-pages">
            <button type="button" disabled={page === 0 || pageLoading} onClick={newer}>{t('proxy.newerHistory')}</button>
            <span>{t('proxy.historyPageLabel')} {page + 1}</span>
            <button type="button" disabled={!hasMore || pageLoading} onClick={older}>{t('proxy.olderHistory')}</button>
          </div>
        </div>}
        second={<div className="websocket-editor">
          {selected ? (
            <>
              <div className="websocket-editor-head">
                <select aria-label={t('websocket.direction')} value={toClient ? 'client' : 'server'} onChange={(event) => setToClient(event.target.value === 'client')}>
                  <option value="server">{t('detail.toServer')}</option>
                  <option value="client">{t('detail.toClient')}</option>
                </select>
                <span className="muted">{selected.is_text ? t('websocket.text') : t('websocket.binary')}</span>
                <span className="spacer" />
                {selected.paused && <button type="button" onClick={() => void forward()}>{t('intercept.forward')}</button>}
                {selected.paused && <button type="button" className="danger" onClick={() => void drop()}>{t('intercept.drop')}</button>}
                <button type="button" disabled={!active} onClick={() => void repeat()}>{t('websocket.repeat')}</button>
              </div>
              <textarea className="mono" value={content} spellCheck={false} onChange={(event) => setContent(event.target.value)} />
            </>
          ) : <p className="muted">{t('websocket.select')}</p>}
        </div>}
      />
    </div>
  );
}

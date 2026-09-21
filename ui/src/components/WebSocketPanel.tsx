import { useEffect, useMemo, useState } from 'react';

import {
  clearWebSocketMessages,
  dropWebSocketMessage,
  forwardWebSocketMessage,
  getWebSocketState,
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

const DEFAULT_RULES: WebSocketInterceptRules = {
  enabled: false,
  client_messages: true,
  server_messages: true,
};

export function WebSocketPanel() {
  const t = useT();
  const [rules, setRules] = useState(DEFAULT_RULES);
  const [connections, setConnections] = useState<WebSocketConnection[]>([]);
  const [messages, setMessages] = useState<WebSocketMessage[]>([]);
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
              setMessages((current) => [event.data, ...current].slice(0, 2000));
              setSelectedId((id) => id ?? event.data.id);
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
              return;
            default:
              return;
          }
        },
      }),
    [],
  );

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
      <div className="websocket-split">
        <div className="websocket-list">
          <table>
            <thead><tr><th>{t('websocket.direction')}</th><th>{t('flow.host')}</th><th>{t('flow.size')}</th><th>{t('common.status')}</th></tr></thead>
            <tbody>
              {messages.map((message) => (
                <tr key={message.id} className={message.id === selectedId ? 'selected' : undefined} onClick={() => setSelectedId(message.id)}>
                  <td>{message.from_client ? t('detail.toServer') : t('detail.toClient')}</td>
                  <td className="mono">{message.host}{message.path}</td>
                  <td>{message.size}</td>
                  <td>{message.paused ? t('websocket.held') : message.dropped ? t('websocket.dropped') : message.injected ? t('websocket.repeated') : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {messages.length === 0 && <p className="muted websocket-empty">{t('websocket.empty')}</p>}
        </div>
        <div className="websocket-editor">
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
        </div>
      </div>
    </div>
  );
}

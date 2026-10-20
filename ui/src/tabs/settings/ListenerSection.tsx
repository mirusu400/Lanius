/** Browser-facing proxy listener collection. */

import { useEffect, useState } from 'react';
import {
  addListener,
  deleteListener,
  getListeners,
  setPrimaryListener,
  updateListener,
} from '../../api/client';
import type {
  ListenerState,
  ListenersState,
  ProxyListenerState,
} from '../../api/types';
import {
  msg,
  rawMsg,
  renderMessage,
  useI18n,
  type Message,
} from '../../i18n';
import { UndoableInput } from '../../components/UndoableText';
import { useSettingsToast } from '../../components/useSettingsToast';

const LOOPBACK = '127.0.0.1';
const ALL_INTERFACES = '0.0.0.0';
const OTHER_HOST = '\u0000other\u0000';

interface ListenerDraft {
  id: string | null;
  host: string;
  port: string;
}

function normalizeState(next: ListenersState | ListenerState): ListenersState {
  if ('listeners' in next && Array.isArray(next.listeners)) {
    return { ...next, addresses: next.addresses ?? [] };
  }
  // Keep Settings usable during a rolling desktop/engine update and in old
  // test fixtures that still return the singular endpoint shape.
  const legacy = next as ListenerState;
  const listener: ProxyListenerState = {
    id: legacy.id ?? 'default',
    host: legacy.host ?? LOOPBACK,
    port: legacy.port,
    running: legacy.running,
    error: legacy.error,
    exposed: legacy.exposed,
    primary: true,
  };
  return {
    listeners: [listener],
    primary_id: listener.id,
    addresses: legacy.addresses ?? [],
  };
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

export function ListenerSection() {
  const { t } = useI18n();
  const saved = useSettingsToast('listener.section');
  const [state, setState] = useState<ListenersState | null>(null);
  const [draft, setDraft] = useState<ListenerDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Message | null>(null);
  const [error, setError] = useState<Message | null>(null);

  const load = (next: ListenersState | ListenerState) => {
    setState(normalizeState(next));
  };

  useEffect(() => {
    getListeners()
      .then(load)
      .catch((err) => setError(rawMsg((err as Error).message)));
  }, []);

  if (!state) {
    return error
      ? <section><div className="banner error">{renderMessage(error, t)}</div></section>
      : null;
  }

  const addresses = state.addresses.length > 0
    ? state.addresses
    : [
        { host: LOOPBACK, label: LOOPBACK },
        { host: ALL_INTERFACES, label: ALL_INTERFACES },
      ];
  const knownDraftHost = draft
    ? addresses.some((entry) => entry.host === draft.host)
    : true;
  const draftExposed = Boolean(draft?.host) && !isLoopback(draft?.host ?? '');

  const beginAdd = () => {
    setDraft({ id: null, host: LOOPBACK, port: '' });
    setNote(null);
    setError(null);
  };

  const beginEdit = (listener: ProxyListenerState) => {
    setDraft({ id: listener.id, host: listener.host, port: String(listener.port) });
    setNote(null);
    setError(null);
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setNote(null);
    setError(null);
    try {
      const port = Number(draft.port);
      const next = draft.id
        ? await updateListener(draft.id, draft.host, port)
        : await addListener(draft.host, port);
      load(next);
      setDraft(null);
      saved();
      setNote(msg(draft.id ? 'listener.updated' : 'listener.added', {
        host: draft.host,
        port: draft.port,
      }));
    } catch (err) {
      setError(msg('listener.failed', {
        host: draft.host,
        port: draft.port,
        message: (err as Error).message,
      }));
      setNote(msg('listener.kept'));
      getListeners().then(load).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (listener: ProxyListenerState) => {
    setBusy(true);
    setNote(null);
    setError(null);
    try {
      load(await deleteListener(listener.id));
      saved();
      if (draft?.id === listener.id) setDraft(null);
      setNote(msg('listener.removed', { host: listener.host, port: listener.port }));
    } catch (err) {
      setError(rawMsg((err as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const makePrimary = async (listener: ProxyListenerState) => {
    setBusy(true);
    setNote(null);
    setError(null);
    try {
      load(await setPrimaryListener(listener.id));
      saved();
      setNote(msg('listener.primaryChanged', {
        host: listener.host,
        port: listener.port,
      }));
    } catch (err) {
      setError(rawMsg((err as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h3>{t('listener.section')}</h3>
      <p className="muted">{t('listener.help')}</p>

      <div className="listener-list">
        {state.listeners.map((listener) => (
          <div className="listener-item" key={listener.id}>
            <div className="listener-summary">
              <span className="mono">{listener.host}:{listener.port}</span>
              <span className={listener.running ? 'pill ok' : 'pill bad'}>
                {listener.running ? t('listener.running') : t('listener.stopped')}
              </span>
              {listener.primary && <span className="pill">{t('listener.primary')}</span>}
              {listener.exposed && <span className="pill warn">{t('listener.exposedShort')}</span>}
            </div>
            {listener.error && (
              <div className="banner error">
                {t('listener.down', { message: listener.error })}
              </div>
            )}
            <div className="listener-actions">
              {!listener.primary && (
                <button
                  type="button"
                  disabled={busy || !listener.running}
                  onClick={() => void makePrimary(listener)}
                >
                  {t('listener.makePrimary')}
                </button>
              )}
              <button type="button" disabled={busy} onClick={() => beginEdit(listener)}>
                {t('listener.edit')}
              </button>
              <button
                type="button"
                className="danger"
                disabled={busy || state.listeners.length === 1}
                onClick={() => void remove(listener)}
              >
                {t('common.delete')}
              </button>
            </div>
          </div>
        ))}
      </div>

      {!draft && (
        <button type="button" disabled={busy || state.listeners.length >= 16} onClick={beginAdd}>
          {t('listener.add')}
        </button>
      )}

      {draft && (
        <div className="listener-editor">
          <h4>{t(draft.id ? 'listener.editTitle' : 'listener.addTitle')}</h4>
          <div className="settings-row">
            <label htmlFor="listener-host">{t('listener.bind')}</label>
            <select
              id="listener-host"
              value={knownDraftHost ? draft.host : OTHER_HOST}
              disabled={busy}
              onChange={(event) => setDraft({
                ...draft,
                host: event.target.value === OTHER_HOST ? '' : event.target.value,
              })}
            >
              {addresses.map((entry) => (
                <option key={entry.host} value={entry.host}>
                  {entry.host === LOOPBACK || entry.host === ALL_INTERFACES
                    ? `${entry.label} (${entry.host})`
                    : entry.host}
                </option>
              ))}
              <option value={OTHER_HOST}>{t('listener.hostOther')}</option>
            </select>
          </div>
          {!knownDraftHost && (
            <div className="settings-row">
              <label htmlFor="listener-custom">{t('listener.hostOther')}</label>
              <UndoableInput
                id="listener-custom"
                className="mono"
                placeholder={t('listener.hostPlaceholder')}
                value={draft.host}
                disabled={busy}
                onValueChange={(host) => setDraft({ ...draft, host })}
              />
            </div>
          )}
          <div className="settings-row">
            <label htmlFor="listener-port">{t('listener.port')}</label>
            <UndoableInput
              id="listener-port"
              type="number"
              min={1}
              max={65535}
              className="mono"
              value={draft.port}
              disabled={busy}
              onValueChange={(port) => setDraft({ ...draft, port })}
            />
          </div>
          {draftExposed && <p className="banner warn">{t('listener.exposed')}</p>}
          {!draftExposed && draft.host && <p className="muted">{t('listener.localOnly')}</p>}
          <div className="listener-actions">
            <button
              type="button"
              disabled={busy || !draft.host || !draft.port}
              onClick={() => void save()}
            >
              {t('listener.save')}
            </button>
            <button type="button" disabled={busy} onClick={() => setDraft(null)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {note && <p className="muted">{renderMessage(note, t)}</p>}
      {error && <div className="banner error">{renderMessage(error, t)}</div>}
    </section>
  );
}

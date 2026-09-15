/** Where the proxy listens. */

import { useEffect, useState } from 'react';
import {
  getListener,
  setListener,
} from '../../api/client';
import type { ListenerState } from '../../api/types';
import {
  msg,
  rawMsg,
  renderMessage,
  useI18n,
  type Message,
} from '../../i18n';

const LOOPBACK = '127.0.0.1';
const ALL_INTERFACES = '0.0.0.0';
/** Dropdown value meaning "let me type an address myself". */
const OTHER_HOST = '\u0000other\u0000';

/** Is this address reachable only from this machine?
 *
 * Kept deliberately simple: the engine decides for real, this only drives
 * the warning shown while the user is still choosing.
 */
function isLoopback(host: string): boolean {
  return host === 'localhost' || host.startsWith('127.');
}

export function ListenerSection() {
  const { t } = useI18n();
  const [state, setState] = useState<ListenerState | null>(null);
  const [port, setPort] = useState('');
  const [host, setHost] = useState('');
  // Held separately: the dropdown falls back to a free-text field for an
  // address that is not one of the offered ones.
  const [customHost, setCustomHost] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Message | null>(null);
  const [error, setError] = useState<Message | null>(null);

  const load = (next: ListenerState) => {
    // An older engine, or a partial response, must not take the section
    // down: without an address list there is still a port to fix.
    setState({ ...next, addresses: next.addresses ?? [] });
    setPort(String(next.port ?? ''));
    setHost(next.host ?? LOOPBACK);
  };

  useEffect(() => {
    getListener()
      .then(load)
      .catch((err) => setError(rawMsg((err as Error).message)));
  }, []);

  if (!state) return null;

  const addresses =
    state.addresses.length > 0
      ? state.addresses
      : [
          { host: LOOPBACK, label: LOOPBACK },
          { host: ALL_INTERFACES, label: ALL_INTERFACES },
        ];
  const known = addresses.some((entry) => entry.host === host);
  const chosenHost = known ? host : customHost || host;
  const exposed = chosenHost !== '' && !isLoopback(chosenHost);
  const changed =
    chosenHost !== state.host || port !== String(state.port);

  const apply = async () => {
    setBusy(true);
    setNote(null);
    setError(null);
    const wanted = Number(port);
    try {
      const next = await setListener(chosenHost, wanted);
      load(next);
      setCustomHost('');
      setNote(msg('listener.applied', { host: next.host, port: next.port }));
    } catch (err) {
      setError(
        msg('listener.failed', {
          host: chosenHost,
          port: port,
          message: (err as Error).message,
        }),
      );
      // The engine rolls back, so say so rather than leaving the user
      // wondering whether they have a proxy at all.
      setNote(msg('listener.kept'));
      getListener().then(load).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h3>{t('listener.section')}</h3>
      <p className="muted">{t('listener.help')}</p>

      {!state.running && state.error && (
        <div className="banner error">
          {t('listener.down', { message: state.error })}
          <br />
          {t('listener.downHint')}
        </div>
      )}

      <div className="settings-row">
        <label htmlFor="listener-port">{t('listener.port')}</label>
        <input
          id="listener-port"
          type="number"
          min={1}
          max={65535}
          className="mono"
          value={port}
          disabled={busy}
          onChange={(event) => setPort(event.target.value)}
        />
      </div>

      <div className="settings-row">
        <label htmlFor="listener-host">{t('listener.bind')}</label>
        <select
          id="listener-host"
          value={known ? host : OTHER_HOST}
          disabled={busy}
          onChange={(event) => {
            if (event.target.value === OTHER_HOST) {
              setHost(OTHER_HOST);
              setCustomHost('');
            } else {
              setHost(event.target.value);
            }
          }}
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

      {!known && (
        <div className="settings-row">
          <label htmlFor="listener-custom">{t('listener.hostOther')}</label>
          <input
            id="listener-custom"
            className="mono"
            placeholder={t('listener.hostPlaceholder')}
            value={customHost}
            disabled={busy}
            onChange={(event) => setCustomHost(event.target.value)}
          />
        </div>
      )}

      <div className="settings-row">
        <button
          type="button"
          disabled={busy || !changed || chosenHost === ''}
          onClick={() => void apply()}
        >
          {t('listener.apply')}
        </button>
      </div>

      <p className={exposed ? 'banner warn' : 'muted'}>
        {exposed ? t('listener.exposed') : t('listener.localOnly')}
      </p>

      {note && <p className="muted">{renderMessage(note, t)}</p>}
      {error && <div className="banner error">{renderMessage(error, t)}</div>}
    </section>
  );
}

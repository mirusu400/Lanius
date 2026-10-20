/** Exact hosts whose upstream certificate is deliberately not verified. */

import { useEffect, useState } from 'react';
import {
  getTlsExceptions,
  getTlsInsecure,
  setTlsExceptions,
  setTlsInsecure,
} from '../../api/client';
import { msg, rawMsg, renderMessage, useI18n, type Message } from '../../i18n';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { UndoableInput } from '../../components/UndoableText';

export function TlsExceptionsSection() {
  const { t } = useI18n();
  const [hosts, setHosts] = useState<string[] | null>(null);
  const [insecure, setInsecure] = useState<boolean | null>(null);
  const [host, setHost] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmingInsecure, setConfirmingInsecure] = useState(false);
  const [note, setNote] = useState<Message | null>(null);
  const [error, setError] = useState<Message | null>(null);

  useEffect(() => {
    Promise.all([getTlsExceptions(), getTlsInsecure()]).then(([exceptions, all]) => {
      if (exceptions && Array.isArray(exceptions.hosts)) setHosts(exceptions.hosts);
      setInsecure(Boolean(all?.enabled));
    }).catch((err) => setError(rawMsg((err as Error).message)));
  }, []);

  const save = async (next: string[], done: Message) => {
    setBusy(true);
    setNote(null);
    setError(null);
    try {
      setHosts((await setTlsExceptions(next)).hosts);
      setHost('');
      setNote(done);
    } catch (err) {
      setError(rawMsg((err as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const changeInsecure = async (enabled: boolean) => {
    setConfirmingInsecure(false);
    setBusy(true);
    setNote(null);
    setError(null);
    try {
      setInsecure((await setTlsInsecure(enabled)).enabled);
      setNote(msg(enabled ? 'tlsExceptions.insecureEnabled' : 'tlsExceptions.insecureDisabled'));
    } catch (err) {
      setError(rawMsg((err as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h3>{t('tlsExceptions.section')}</h3>
      <p className="muted">{t('tlsExceptions.help')}</p>
      <div className="settings-row">
        <label>
          <input type="checkbox" checked={insecure ?? false} disabled={busy || insecure === null}
            onChange={(event) => event.target.checked
              ? setConfirmingInsecure(true)
              : void changeInsecure(false)} />{' '}
          {t('tlsExceptions.insecure')}
        </label>
      </div>
      <p className="muted">{t('tlsExceptions.insecureHelp')}</p>
      {insecure && <p className="banner warn" role="status">{t('tlsExceptions.insecureActive')}</p>}
      {hosts && (hosts.length ? (
        <ul className="tls-exceptions">
          {hosts.map((item) => (
            <li key={item}>
              <span className="mono">{item}</span>
              <button type="button" disabled={busy}
                aria-label={t('tlsExceptions.removeHost', { host: item })}
                onClick={() => void save(hosts.filter((other) => other !== item), msg('tlsExceptions.removed', { host: item }))}>
                {t('tlsExceptions.remove')}
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="muted">{t('tlsExceptions.none')}</p>)}
      <form className="settings-row" onSubmit={(event) => {
        event.preventDefault();
        const value = host.trim();
        if (hosts && value) void save([...hosts, value], msg('tlsExceptions.added', { host: value }));
      }}>
        <label htmlFor="tls-exception-host">{t('tlsExceptions.host')}</label>
        <UndoableInput id="tls-exception-host" className="mono" value={host} disabled={busy || !hosts}
          placeholder="app.example.test" onValueChange={setHost} />
        <button type="submit" disabled={busy || !hosts || !host.trim()}>{t('tlsExceptions.add')}</button>
      </form>
      <p className="muted">{t('tlsExceptions.restart')}</p>
      {note && <p className="muted" role="status">{renderMessage(note, t)}</p>}
      {error && <div className="banner error" role="alert">{renderMessage(error, t)}</div>}
      <ConfirmDialog
        open={confirmingInsecure}
        title={t('tlsExceptions.insecureConfirmTitle')}
        message={t('tlsExceptions.insecureConfirmMessage')}
        confirmLabel={t('tlsExceptions.insecureConfirm')}
        onConfirm={() => void changeInsecure(true)}
        onCancel={() => setConfirmingInsecure(false)}
      />
    </section>
  );
}

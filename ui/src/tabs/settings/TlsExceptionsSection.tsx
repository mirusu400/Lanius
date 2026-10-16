/** Exact hosts whose upstream certificate is deliberately not verified. */

import { useEffect, useState } from 'react';
import { getTlsExceptions, setTlsExceptions } from '../../api/client';
import { msg, rawMsg, renderMessage, useI18n, type Message } from '../../i18n';
import { UndoableInput } from '../../components/UndoableText';

export function TlsExceptionsSection() {
  const { t } = useI18n();
  const [hosts, setHosts] = useState<string[] | null>(null);
  const [host, setHost] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Message | null>(null);
  const [error, setError] = useState<Message | null>(null);

  useEffect(() => {
    getTlsExceptions().then((state) => {
      if (state && Array.isArray(state.hosts)) setHosts(state.hosts);
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

  return (
    <section>
      <h3>{t('tlsExceptions.section')}</h3>
      <p className="muted">{t('tlsExceptions.help')}</p>
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
    </section>
  );
}

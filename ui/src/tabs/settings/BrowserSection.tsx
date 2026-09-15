/** The bundled browser, already pointed at the proxy. */

import { useEffect, useState } from 'react';
import {
  clearBrowserProfile,
  getBrowserState,
  openBrowser,
} from '../../api/client';
import type { BrowserState } from '../../api/types';
import {
  msg,
  rawMsg,
  renderMessage,
  useI18n,
  type Message,
} from '../../i18n';

export function BrowserSection() {
  const { t } = useI18n();
  const [state, setState] = useState<BrowserState | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Message | null>(null);
  const [error, setError] = useState<Message | null>(null);

  useEffect(() => {
    getBrowserState()
      .then(setState)
      .catch((err) => setError(rawMsg((err as Error).message)));
  }, []);

  if (!state) return null;

  const open = async () => {
    setBusy(true);
    setNote(null);
    setError(null);
    try {
      const launched = await openBrowser();
      setNote(msg('browser.opened', { name: launched.name }));
    } catch (err) {
      setError(msg('browser.failed', { message: (err as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (!window.confirm(t('browser.confirmClear'))) return;
    setBusy(true);
    setNote(null);
    setError(null);
    try {
      await clearBrowserProfile();
      setNote(msg('browser.cleared'));
    } catch (err) {
      setError(rawMsg((err as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h3>{t('browser.section')}</h3>
      <p className="muted">{t('browser.help')}</p>

      {!state.available ? (
        <div className="banner warn">{t('browser.unavailable')}</div>
      ) : (
        <>
          {!state.ca_trusted && (
            <div className="banner warn">{t('browser.noCa')}</div>
          )}
          <dl className="settings-grid mono">
            <dt>{t('browser.profile')}</dt>
            <dd>{state.profile}</dd>
          </dl>
          <div className="settings-row">
            <button type="button" disabled={busy} onClick={() => void open()}>
              {busy ? t('browser.opening') : t('browser.open')}
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => void clear()}
            >
              {t('browser.clearProfile')}
            </button>
          </div>
        </>
      )}

      {note && <p className="muted">{renderMessage(note, t)}</p>}
      {error && <div className="banner error">{renderMessage(error, t)}</div>}
    </section>
  );
}

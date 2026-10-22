/** The bundled browser, already pointed at the proxy. */

import { useEffect, useState } from 'react';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useToast } from '../../components/Toast';
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
  const { showToast } = useToast();
  const [state, setState] = useState<BrowserState | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [confirmClear, setConfirmClear] = useState(false);
  const [note, setNote] = useState<Message | null>(null);
  const [error, setError] = useState<Message | null>(null);

  useEffect(() => {
    getBrowserState()
      .then(setState)
      .catch((err) => setError(msg('browser.loadFailed', { message: (err as Error).message })))
      .finally(() => setLoading(false));
  }, []);

  const retry = async () => {
    setLoading(true);
    setError(null);
    try {
      setState(await getBrowserState());
    } catch (err) {
      setError(msg('browser.loadFailed', { message: (err as Error).message }));
    } finally {
      setLoading(false);
    }
  };

  const open = async () => {
    setBusy(true);
    setNote(null);
    setError(null);
    try {
      const launched = await openBrowser();
      setNote(msg('browser.opened', { name: launched.name }));
      showToast({ message: `${t('browser.section')}: ${t('browser.opened', { name: launched.name })}`,
        tone: 'success', category: 'browser' });
    } catch (err) {
      setError(msg('browser.failed', { message: (err as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setConfirmClear(false);
    setBusy(true);
    setNote(null);
    setError(null);
    try {
      await clearBrowserProfile();
      setNote(msg('browser.cleared'));
      showToast({ message: `${t('browser.section')}: ${t('browser.cleared')}`, tone: 'success', category: 'browser' });
    } catch (err) {
      setError(rawMsg((err as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section>
      <h3>{t('browser.section')}</h3>
      <p className="muted">{t('browser.help')}</p>

      {loading ? (
        <p className="muted" role="status">{t('common.loading')}</p>
      ) : !state ? (
        <div className="settings-load-error">
          {error && <div className="banner error">{renderMessage(error, t)}</div>}
          <button type="button" onClick={() => void retry()}>{t('common.retry')}</button>
        </div>
      ) : !state.available ? (
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
              onClick={() => setConfirmClear(true)}
            >
              {t('browser.clearProfile')}
            </button>
          </div>
        </>
      )}

      {state && note && <p className="muted">{renderMessage(note, t)}</p>}
      {state && error && <div className="banner error">{renderMessage(error, t)}</div>}
      </section>
      <ConfirmDialog
        open={confirmClear}
        title={t('browser.clearProfile')}
        message={t('browser.confirmClear')}
        confirmLabel={t('browser.clearProfile')}
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => void clear()}
      />
    </>
  );
}

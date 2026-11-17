/** Choose which installed browser to open through the Lanius proxy. */

import { useEffect, useState } from 'react';

import { getBrowserState, openBrowser } from '../api/client';
import type { BrowserState, LaunchedBrowser } from '../api/types';
import { useT } from '../i18n';
import { openDocsPage } from '../docs/navigation';
import { Dialog } from './Dialog';
import { useToast } from './Toast';

export function BrowserLaunchDialog({ open, onClose, onLaunched }: {
  open: boolean;
  onClose: () => void;
  onLaunched: (browser: LaunchedBrowser) => void;
}) {
  const t = useT();
  const { showToast } = useToast();
  const [state, setState] = useState<BrowserState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    getBrowserState()
      .then((next) => { if (active) setState(next); })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { active = false; };
  }, [open]);

  const close = () => {
    if (busy) return;
    setState(null);
    setError(null);
    onClose();
  };

  const choices = state?.browsers?.length
    ? state.browsers
    : state?.name ? [{ id: '', name: state.name, available: state.available }] : [];

  const launch = async (browserId: string) => {
    setBusy(true);
    setError(null);
    try {
      const launched = await openBrowser(browserId ? { browserId } : undefined);
      onLaunched(launched);
      setState(null);
      onClose();
      if (browserId === 'firefox' || launched.id === 'firefox') {
        showToast({
          id: 'firefox-ca-guide',
          message: t('browser.firefoxCaToast'),
          tone: 'info',
          durationMs: 0,
          onClick: () => openDocsPage('guide:firefox-ca'),
        });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      title={t('browser.choose')}
      onClose={close}
      className="browser-launch-dialog"
    >
      <p className="muted">{t('browser.chooseHelp')}</p>
      {!state && !error && <p className="muted" role="status">{t('common.loading')}</p>}
      {state && choices.length === 0 && <p className="muted">{t('browser.unavailable')}</p>}
      {state && choices.length > 0 && <div className="browser-launch-choices">
        {choices.map((choice) => (
          <div className="browser-launch-choice" key={choice.id || choice.name}>
            <button
              type="button"
              disabled={busy || !choice.available}
              onClick={() => void launch(choice.id)}
            >
              {t('browser.openNamed', { name: choice.name })}
            </button>
            {!choice.available && <span className="muted">{t('browser.notInstalled')}</span>}
          </div>
        ))}
      </div>}
      {busy && <p className="muted" role="status">{t('browser.opening')}</p>}
      {error && <p className="field-error" role="alert">{t('browser.failed', { message: error })}</p>}
    </Dialog>
  );
}

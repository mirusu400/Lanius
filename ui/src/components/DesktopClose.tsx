/** Keep the native window open until workspace saves and engine cleanup finish. */

import { useCallback, useEffect, useRef, useState } from 'react';

import { useT } from '../i18n';
import { flushAutosaves } from '../tabs/autosave';
import { CLOSE_REQUESTED, desktopCloseCommand } from '../shutdown';
import { Spinner } from './Spinner';

const SAVE_TIMEOUT_MS = 15_000;

export function DesktopClose() {
  const t = useT();
  const [phase, setPhase] = useState<'saving' | 'stopping' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const dialog = useRef<HTMLDialogElement | null>(null);
  const opener = useRef<Element | null>(null);

  const close = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    setPhase('saving');
    let timeout: number | undefined;
    try {
      // Give the progress circle a paint before even a very quick save.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
      await Promise.race([
        flushAutosaves(),
        new Promise<never>((_resolve, reject) => {
          timeout = window.setTimeout(
            () => reject(new Error(t('shutdown.saveTimeout'))), SAVE_TIMEOUT_MS,
          );
        }),
      ]);
      setPhase('stopping');
      await desktopCloseCommand('finish_close');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      busy.current = false;
    } finally {
      if (timeout !== undefined) window.clearTimeout(timeout);
    }
  }, [t]);

  const cancel = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      await desktopCloseCommand('cancel_close');
      setPhase(null);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    const requested = () => { void close(); };
    window.addEventListener(CLOSE_REQUESTED, requested);
    // Native close requests made before React mounted are delivered here.
    void desktopCloseCommand('close_ready').catch((cause: unknown) => {
      console.error('Could not register the desktop close handler', cause);
    });
    return () => window.removeEventListener(CLOSE_REQUESTED, requested);
  }, [close]);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (phase && !element.open) {
      opener.current = document.activeElement;
      element.showModal();
    } else if (!phase && element.open) {
      element.close();
      if (opener.current instanceof HTMLElement) opener.current.focus();
    }
    const onCancel = (event: Event) => {
      event.preventDefault();
      if (error) void cancel();
    };
    element.addEventListener('cancel', onCancel);
    return () => element.removeEventListener('cancel', onCancel);
  }, [phase, error, cancel]);

  return (
    <dialog
      ref={dialog}
      className="dialog closing-dialog"
      aria-label={t(error ? 'shutdown.failed' : 'shutdown.closing')}
      aria-describedby="shutdown-message"
    >
      <div className="dialog-body">
        {!error && <Spinner label={t('shutdown.closing')} />}
        <h3>{t(error ? 'shutdown.failed' : 'shutdown.closing')}</h3>
        <p id="shutdown-message" className="muted">
          {t(error ? 'shutdown.keptOpen' : phase === 'stopping' ? 'shutdown.stopping' : 'shutdown.saving')}
        </p>
        {error && <p className="banner error" role="alert">{error}</p>}
      </div>
      {error && (
        <footer className="dialog-foot">
          <button type="button" onClick={() => void cancel()}>{t('common.cancel')}</button>
          <button type="button" onClick={() => void close()}>{t('shutdown.retry')}</button>
        </footer>
      )}
    </dialog>
  );
}

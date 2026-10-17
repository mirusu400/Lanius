/** Covers the app while a project cleanup holds the database.
 *
 * The engine cannot record traffic or answer most reads until cleanup
 * finishes, so the rest of the interface is made inert rather than left
 * looking usable. Escape does not close it: there is nothing to cancel.
 */

import { useEffect, useRef } from 'react';

import type { CompactProgress } from '../../api/client';
import { Spinner, useDelayedBusy } from '../../components/Spinner';
import { useT, type Translator } from '../../i18n';

function formatDuration(t: Translator, totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return t('compact.duration.seconds', { seconds });
  if (seconds < 3600) {
    return t('compact.duration.minutes', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
  }
  return t('compact.duration.hours', {
    hours: Math.floor(seconds / 3600),
    minutes: Math.floor((seconds % 3600) / 60),
  });
}

export function CompactProgressDialog({
  open,
  progress,
}: {
  open: boolean;
  progress: CompactProgress | null;
}) {
  const t = useT();
  const dialog = useRef<HTMLDialogElement | null>(null);
  const opener = useRef<Element | null>(null);
  // A cleanup with nothing to do finishes in a moment; flashing a
  // full-screen shield for it reads as a glitch. The buttons are already
  // disabled while it runs.
  const visible = useDelayedBusy(open);
  const wanted = useRef(false);

  useEffect(() => {
    wanted.current = visible;
    const element = dialog.current;
    if (!element) return;
    if (visible && !element.open) {
      opener.current = document.activeElement;
      element.showModal();
    } else if (!visible && element.open) {
      element.close();
      if (opener.current instanceof HTMLElement) opener.current.focus();
    }
  }, [visible]);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const onCancel = (event: Event) => event.preventDefault();
    // Chromium ignores preventDefault on a repeated Escape without user
    // activation and closes the dialog anyway, so put it straight back.
    const onClose = () => { if (wanted.current && !element.open) element.showModal(); };
    element.addEventListener('cancel', onCancel);
    element.addEventListener('close', onClose);
    return () => {
      element.removeEventListener('cancel', onCancel);
      element.removeEventListener('close', onClose);
    };
  }, []);

  const phase = progress?.phase ?? 'preparing';
  const percent = Math.floor(progress?.percent ?? 0);
  const estimated = progress?.estimated ?? true;
  const phaseText = t(`compact.phase.${phase}`);

  return (
    <dialog
      ref={dialog}
      className="dialog compact-progress-dialog"
      aria-label={t('compact.progressTitle')}
      aria-describedby="compact-progress-phase"
    >
      {visible && (
        <div className="dialog-body">
          <div className="compact-progress-ring">
            {/* A fill that sits still for minutes reads as a hang, so an
                inferred phase keeps turning and the number carries the estimate. */}
            <Spinner label={t('compact.progressTitle')} value={estimated ? undefined : percent} />
            <strong className="compact-progress-percent" aria-hidden={!estimated}>
              {percent}%
              {estimated && <small>{t('compact.estimate')}</small>}
            </strong>
          </div>
          <h3>{t('compact.progressTitle')}</h3>
          <p id="compact-progress-phase" role="status" aria-live="polite">{phaseText}</p>
          {phase === 'deleting' && progress && progress.total_flows > 0 && (
            <p className="muted">{t('compact.deletionCount', {
              processed: progress.processed_flows.toLocaleString(),
              total: progress.total_flows.toLocaleString(),
            })}</p>
          )}
          <p className="muted compact-progress-times">
            {t('compact.elapsedTime', { time: formatDuration(t, progress?.elapsed_seconds ?? 0) })}
            {' · '}
            {progress?.eta_seconds == null
              ? t('compact.remainingUnknown')
              : t('compact.remaining', { time: formatDuration(t, progress.eta_seconds) })}
          </p>
          {estimated && ['optimizing', 'vacuuming', 'checkpointing'].includes(phase) && (
            <p className="muted">{t('compact.longStep')}</p>
          )}
          <p className="muted">{t('compact.keepOpen')}</p>
        </div>
      )}
    </dialog>
  );
}

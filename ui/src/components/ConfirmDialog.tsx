/** A yes/no dialog for something that cannot be undone.
 *
 * Deleting captured requests is permanent and the menu item sits next to
 * ordinary ones, so a misclick has to be recoverable by doing nothing.
 * Built on the same <dialog> as everything else rather than window
 * .confirm, which the desktop shell renders as a bare system alert with
 * the wrong app name on it.
 */

import { useEffect, useRef } from 'react';

import { Dialog } from './Dialog';
import { useT } from '../i18n';

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  /** Names the action, so the button is not a bare "OK". */
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  // Focus lands on Cancel, not on the destructive button: Enter should
  // not confirm something permanent that was opened by accident.
  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  return (
    <Dialog
      open={open}
      title={title}
      onClose={onCancel}
      className="confirm-dialog"
      footer={
        <>
          <span className="spacer" />
          <button type="button" ref={cancelRef} onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button type="button" className="danger" onClick={onConfirm}>
            {confirmLabel ?? t('common.confirm')}
          </button>
        </>
      }
    >
      <p>{message}</p>
    </Dialog>
  );
}

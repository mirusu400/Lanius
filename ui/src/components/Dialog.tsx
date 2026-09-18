/** A modal dialog.
 *
 * Built on the native <dialog>, so the browser handles the top layer,
 * the backdrop and Escape rather than this reimplementing them badly.
 * Focus goes into the dialog on open and returns to whatever opened it
 * on close, which is the part that is easy to get wrong and annoying to
 * live with.
 */

import { useEffect, useRef } from 'react';

import { useT } from '../i18n';

export function Dialog({
  open,
  title,
  onClose,
  children,
  footer,
  className,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}) {
  const t = useT();
  const ref = useRef<HTMLDialogElement | null>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      opener.current = document.activeElement;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
      // Back to the button that opened it, so the keyboard does not land
      // at the top of the page.
      if (opener.current instanceof HTMLElement) opener.current.focus();
    }
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    // Escape closes a native dialog by itself; this keeps React's idea of
    // whether it is open in step with that.
    const onCancel = (event: Event) => {
      event.preventDefault();
      onClose();
    };
    dialog.addEventListener('cancel', onCancel);
    return () => dialog.removeEventListener('cancel', onCancel);
  }, [onClose]);

  return (
    <dialog
      ref={ref}
      className={className ? `dialog ${className}` : 'dialog'}
      aria-label={title}
      onClick={(event) => {
        // Clicking the backdrop closes it. The dialog element covers the
        // whole viewport, so the target is the dialog itself only when
        // the click missed its contents.
        if (event.target === ref.current) onClose();
      }}
    >
      <header className="dialog-head">
        <h3>{title}</h3>
        <button type="button" aria-label={t('common.close')} onClick={onClose}>
          ×
        </button>
      </header>
      <div className="dialog-body">{children}</div>
      {footer && <footer className="dialog-foot">{footer}</footer>}
    </dialog>
  );
}

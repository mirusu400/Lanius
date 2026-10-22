/** A themed replacement for window.prompt with validation and keyboard submit. */

import { useEffect, useId, useRef } from 'react';

import { useT } from '../i18n';
import { Dialog } from './Dialog';

export function TextPromptDialog({
  open,
  title,
  label,
  initialValue = '',
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  label: string;
  initialValue?: string;
  confirmLabel: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const inputId = useId();
  const formId = useId();

  useEffect(() => {
    if (!open) return;
    const input = inputRef.current;
    if (input) input.value = initialValue;
    if (confirmRef.current) confirmRef.current.disabled = !initialValue.trim();
    // Dialog.showModal() runs in an effect too. Waiting one frame puts focus
    // in the field after the native dialog has entered the top layer.
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [initialValue, open]);

  const submit = () => {
    const trimmed = inputRef.current?.value.trim() ?? '';
    if (trimmed) onConfirm(trimmed);
  };

  return (
    <Dialog
      open={open}
      title={title}
      onClose={onCancel}
      className="text-prompt-dialog"
      footer={
        <>
          <span className="spacer" />
          <button type="button" onClick={onCancel}>{t('common.cancel')}</button>
          <button
            ref={confirmRef}
            type="submit"
            className="send"
            form={formId}
            disabled={!initialValue.trim()}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="text-prompt-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label htmlFor={inputId}>{label}</label>
        <input
          id={inputId}
          ref={inputRef}
          defaultValue={initialValue}
          onInput={(event) => {
            if (confirmRef.current) {
              confirmRef.current.disabled = !event.currentTarget.value.trim();
            }
          }}
        />
      </form>
    </Dialog>
  );
}

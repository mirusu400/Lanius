/** The payload list for one fuzz position.
 *
 * A place to type a list, with the library a click away when the list is
 * longer than something worth typing.
 */

import { useCallback, useEffect, useState } from 'react';

import { listPayloadSets, savePayloadSet } from '../api/client';
import { PayloadLibrary } from './PayloadLibrary';
import { PayloadMaker } from './PayloadMaker';
import { TextPromptDialog } from './TextPromptDialog';
import { errorMessage, renderMessage, type Message } from '../i18n/message';
import { useT } from '../i18n';
import { UndoableTextarea } from './UndoableText';

export function PayloadPicker({
  index,
  value,
  onChange,
  idPrefix = '',
  requestCount,
}: {
  /** Which position this list fills, for the heading. */
  index: number;
  value: string;
  onChange: (payloads: string) => void;
  idPrefix?: string;
  requestCount?: (count: number) => number;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [makerOpen, setMakerOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Message | null>(null);

  const count = value.split('\n').filter((line) => line.trim()).length;

  const save = useCallback(async (name: string) => {
    setSaveOpen(false);
    setBusy(true);
    setError(null);
    try {
      await savePayloadSet({ name, payloads: value });
      // Confirms it landed, and surfaces a name clash as a replacement
      // rather than leaving the user guessing.
      await listPayloadSets();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [value]);

  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(null), 6000);
    return () => window.clearTimeout(timer);
  }, [error]);

  return (
    <div className="payload-picker">
      <div className="payload-picker-head">
        <label htmlFor={`${idPrefix}payloads-${index}`}>
          {t('fuzzer.payloadSet', { index: String(index + 1) })}
        </label>
        <span className="muted">
          {t('payloads.count', { count: String(count) })}
        </span>
        <div className="spacer" />
        <button type="button" onClick={() => setMakerOpen(true)}>
          {t('payloadMaker.title')}
        </button>
        <button type="button" disabled={busy || !count} onClick={() => setSaveOpen(true)}>
          {t('payloads.save')}
        </button>
        <button type="button" onClick={() => setOpen(true)}>
          {t('payloads.library')}
        </button>
      </div>

      {error && <div className="banner error">{renderMessage(error, t)}</div>}

      <UndoableTextarea
        id={`${idPrefix}payloads-${index}`}
        className="fuzzer-payloads mono"
        spellCheck={false}
        value={value}
        historyKey={`${idPrefix}payloads-${index}`}
        onValueChange={onChange}
      />

      <PayloadLibrary
        open={open}
        onClose={() => setOpen(false)}
        onUse={onChange}
      />
      <PayloadMaker
        open={makerOpen}
        value={value}
        onClose={() => setMakerOpen(false)}
        onUse={onChange}
        requestCount={requestCount}
      />
      <TextPromptDialog
        open={saveOpen}
        title={t('payloads.saveTitle')}
        label={t('payloads.namePrompt')}
        confirmLabel={t('payloads.save')}
        onCancel={() => setSaveOpen(false)}
        onConfirm={(name) => void save(name)}
      />
    </div>
  );
}

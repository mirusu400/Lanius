/** The payload list for one attack position.
 *
 * A place to type a list, with the library a click away when the list is
 * longer than something worth typing.
 */

import { useCallback, useEffect, useState } from 'react';

import { listPayloadSets, savePayloadSet } from '../api/client';
import { PayloadLibrary } from './PayloadLibrary';
import { errorMessage, renderMessage, type Message } from '../i18n/message';
import { useT } from '../i18n';

export function PayloadPicker({
  index,
  value,
  onChange,
}: {
  /** Which position this list fills, for the heading. */
  index: number;
  value: string;
  onChange: (payloads: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Message | null>(null);

  const count = value.split('\n').filter((line) => line.trim()).length;

  const save = useCallback(async () => {
    const name = window.prompt(t('payloads.namePrompt'));
    if (!name) return;
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
  }, [t, value]);

  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(null), 6000);
    return () => window.clearTimeout(timer);
  }, [error]);

  return (
    <div className="payload-picker">
      <div className="payload-picker-head">
        <label htmlFor={`payloads-${index}`}>
          {t('intruder.payloadSet', { index: String(index + 1) })}
        </label>
        <span className="muted">
          {t('payloads.count', { count: String(count) })}
        </span>
        <div className="spacer" />
        <button type="button" disabled={busy || !count} onClick={() => void save()}>
          {t('payloads.save')}
        </button>
        <button type="button" onClick={() => setOpen(true)}>
          {t('payloads.library')}
        </button>
      </div>

      {error && <div className="banner error">{renderMessage(error, t)}</div>}

      <textarea
        id={`payloads-${index}`}
        className="intruder-payloads mono"
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />

      <PayloadLibrary
        open={open}
        onClose={() => setOpen(false)}
        onUse={onChange}
      />
    </div>
  );
}

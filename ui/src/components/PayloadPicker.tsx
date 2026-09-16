/** Picking a payload list for an attack position.
 *
 * Three ways in, because the work is different each time: type a handful
 * by hand, reach for a list you saved earlier, or pull one down from
 * SecLists so you are not hunting for a wordlist mid-test.
 */

import { useCallback, useEffect, useState } from 'react';

import {
  deletePayloadSet,
  getPayloadSet,
  importWordlist,
  listPayloadSets,
  listWordlists,
  savePayloadSet,
  type PayloadSetSummary,
  type WordlistEntry,
} from '../api/client';
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
  const [sets, setSets] = useState<PayloadSetSummary[]>([]);
  const [wordlists, setWordlists] = useState<WordlistEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Message | null>(null);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSets((await listPayloadSets()).items);
    } catch {
      // A saved set being unavailable should not stop you typing one in.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!open || wordlists.length > 0) return;
    // Only when the panel is opened: nothing should reach the network
    // because a tab was rendered.
    listWordlists()
      .then((data) => setWordlists(data.items))
      .catch((err) => setError(errorMessage(err)));
  }, [open, wordlists.length]);

  const count = value.split('\n').filter((line) => line.trim()).length;

  const loadSet = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const found = await getPayloadSet(id);
      onChange(found.payloads.join('\n'));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const name = window.prompt(t('payloads.namePrompt'));
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      await savePayloadSet({ name, payloads: value });
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const fetchList = async (entry: WordlistEntry) => {
    setBusy(true);
    setError(null);
    try {
      const saved = await importWordlist({ list_id: entry.id });
      await refresh();
      await loadSet(saved.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      await deletePayloadSet(id);
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="payload-picker">
      <div className="payload-picker-head">
        <label htmlFor={`payloads-${index}`}>
          {t('intruder.payloadSet', { index: String(index + 1) })}
        </label>
        <span className="muted">{t('payloads.count', { count: String(count) })}</span>
        <div className="spacer" />
        <button type="button" disabled={busy || !count} onClick={() => void save()}>
          {t('payloads.save')}
        </button>
        <button type="button" onClick={() => setOpen((v) => !v)}>
          {t('payloads.library')}
        </button>
      </div>

      {open && (
        <div className="payload-library">
          {error && <div className="banner error">{renderMessage(error, t)}</div>}

          <h5>{t('payloads.saved')}</h5>
          {sets.length === 0 ? (
            <p className="muted">{t('payloads.noneSaved')}</p>
          ) : (
            <ul className="payload-set-list">
              {sets.map((set) => (
                <li key={set.id}>
                  <button
                    type="button"
                    className="link-button"
                    disabled={busy}
                    onClick={() => void loadSet(set.id)}
                  >
                    {set.name}
                  </button>
                  <span className="muted">
                    {t('payloads.count', { count: String(set.count) })}
                  </span>
                  <button
                    type="button"
                    className="link-button danger"
                    disabled={busy}
                    onClick={() => void remove(set.id)}
                  >
                    {t('common.delete')}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <h5>{t('payloads.seclists')}</h5>
          <p className="muted">{t('payloads.seclistsHelp')}</p>
          <ul className="payload-set-list">
            {wordlists.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  className="link-button"
                  disabled={busy}
                  onClick={() => void fetchList(entry)}
                >
                  {entry.name}
                </button>
                {/* Roughly how big, so the size is known before the
                    download rather than after. */}
                <span className="muted">
                  {t('payloads.approx', { count: String(entry.approx_lines) })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <textarea
        id={`payloads-${index}`}
        className="intruder-payloads mono"
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

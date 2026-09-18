/** Managing payload lists.
 *
 * This used to be a 260px strip wedged above the editor, which was too
 * small to read a list in, let alone judge one. It is a dialog now, with
 * room to see what is saved, what SecLists offers, and what is actually
 * inside a list before it is used.
 */

import { useCallback, useEffect, useState } from 'react';

import {
  deletePayloadSet,
  getPayloadSet,
  importWordlist,
  listPayloadSets,
  listWordlists,
  renamePayloadSet,
  type PayloadSetSummary,
  type WordlistEntry,
} from '../api/client';
import { Dialog } from './Dialog';
import { errorMessage, renderMessage, type Message } from '../i18n/message';
import { useT } from '../i18n';

/** Enough of a list to judge it by, without rendering 30,000 lines. */
const PREVIEW_LINES = 200;

type Source = 'saved' | 'seclists';

export function PayloadLibrary({
  open,
  onClose,
  onUse,
}: {
  open: boolean;
  onClose: () => void;
  /** Called with the chosen payloads, one per line. */
  onUse: (payloads: string) => void;
}) {
  const t = useT();
  const [source, setSource] = useState<Source>('saved');
  const [sets, setSets] = useState<PayloadSetSummary[]>([]);
  const [wordlists, setWordlists] = useState<WordlistEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Message | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSets((await listPayloadSets()).items);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refresh();
    // Only once the dialog is open: nothing should reach the network
    // because a tab was rendered.
    listWordlists()
      .then((data) => setWordlists(data.items))
      .catch(() => {
        // Offline is fine; saved sets still work.
      });
  }, [open, refresh]);

  useEffect(() => {
    if (!open) {
      setSelected(null);
      setPreview(null);
      setError(null);
    }
  }, [open]);

  const choose = async (set: PayloadSetSummary) => {
    setSelected(set.id);
    setPreview(null);
    setError(null);
    try {
      const found = await getPayloadSet(set.id);
      setPreview(found.payloads);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const fetchList = async (entry: WordlistEntry) => {
    setBusy(true);
    setError(null);
    try {
      const saved = await importWordlist({ list_id: entry.id });
      await refresh();
      // Straight to the downloaded list, which is what was wanted.
      setSource('saved');
      await choose(saved);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const rename = async (set: PayloadSetSummary) => {
    const name = window.prompt(t('payloads.namePrompt'), set.name);
    if (!name || name === set.name) return;
    setBusy(true);
    try {
      await renamePayloadSet(set.id, name);
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (set: PayloadSetSummary) => {
    setBusy(true);
    try {
      await deletePayloadSet(set.id);
      if (selected === set.id) {
        setSelected(null);
        setPreview(null);
      }
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const downloaded = new Set(sets.map((s) => s.source).filter(Boolean));
  const chosen = sets.find((s) => s.id === selected) ?? null;

  return (
    <Dialog
      open={open}
      title={t('payloads.library')}
      onClose={onClose}
      className="payload-dialog"
      footer={
        <>
          <span className="muted">
            {chosen
              ? t('payloads.count', { count: String(chosen.count) })
              : t('payloads.pickOne')}
          </span>
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="send"
            disabled={!preview || preview.length === 0}
            onClick={() => {
              if (preview) onUse(preview.join('\n'));
              onClose();
            }}
          >
            {t('payloads.use')}
          </button>
        </>
      }
    >
      {error && <div className="banner error">{renderMessage(error, t)}</div>}

      <div className="payload-dialog-body">
        <div className="payload-sources">
          <div className="subtabs">
            <button
              className={source === 'saved' ? 'active' : ''}
              onClick={() => setSource('saved')}
            >
              {t('payloads.saved')}
            </button>
            <button
              className={source === 'seclists' ? 'active' : ''}
              onClick={() => setSource('seclists')}
            >
              {t('payloads.seclists')}
            </button>
          </div>

          {source === 'saved' ? (
            sets.length === 0 ? (
              <p className="muted">{t('payloads.noneSaved')}</p>
            ) : (
              <ul className="payload-set-list">
                {sets.map((set) => (
                  <li
                    key={set.id}
                    className={selected === set.id ? 'selected' : undefined}
                  >
                    <button
                      type="button"
                      className="payload-set-name"
                      onClick={() => void choose(set)}
                    >
                      <span>{set.name}</span>
                      <span className="muted">
                        {t('payloads.count', { count: String(set.count) })}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="link-button"
                      disabled={busy}
                      onClick={() => void rename(set)}
                    >
                      {t('payloads.rename')}
                    </button>
                    <button
                      type="button"
                      className="link-button danger"
                      disabled={busy}
                      onClick={() => void remove(set)}
                    >
                      {t('common.delete')}
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <>
              <p className="muted">{t('payloads.seclistsHelp')}</p>
              <ul className="payload-set-list">
                {wordlists.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className="payload-set-name"
                      disabled={busy}
                      onClick={() => void fetchList(entry)}
                    >
                      <span>{entry.name}</span>
                      <span className="muted">
                        {t('payloads.approx', {
                          count: String(entry.approx_lines),
                        })}
                      </span>
                    </button>
                    {/* So a list already downloaded is not fetched again
                        without the user meaning to. */}
                    {downloaded.has(entry.url) && (
                      <span className="pill">{t('payloads.downloaded')}</span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <div className="payload-preview">
          {preview === null ? (
            <p className="muted">{t('payloads.previewHint')}</p>
          ) : (
            <>
              <pre className="mono">
                {preview.slice(0, PREVIEW_LINES).join('\n')}
              </pre>
              {preview.length > PREVIEW_LINES && (
                <p className="muted">
                  {t('payloads.previewMore', {
                    count: String(preview.length - PREVIEW_LINES),
                  })}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}

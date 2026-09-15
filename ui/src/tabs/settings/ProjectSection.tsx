/** Saving and restoring the whole capture. */

import { useState } from 'react';
import {
  exportProject,
  importProject,
} from '../../api/client';
import {
  msg,
  rawMsg,
  renderMessage,
  useI18n,
  type Message,
} from '../../i18n';

/** Export and import, plus a reminder that work is saved as you go. */
export function ProjectSection() {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Message | null>(null);
  const [error, setError] = useState<Message | null>(null);

  const download = async (includeFlows: boolean) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const data = await exportProject(includeFlows);
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const stamp = new Date().toISOString().slice(0, 10);
      link.download = `lanius-${stamp}.lanius.json`;
      link.click();
      // Revoking immediately can cancel the download in some browsers.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      setError(rawMsg((err as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const result = await importProject(JSON.parse(await file.text()));
      setNote(
        msg('project.imported', {
          flows: String(result.flows ?? 0),
          scope: String(result.scope ?? 0),
        }),
      );
    } catch (err) {
      setError(msg('project.importFailed', { message: (err as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h3>{t('project.section')}</h3>
      <p className="muted">{t('project.help')}</p>

      <div className="project-actions">
        <button type="button" disabled={busy} onClick={() => void download(true)}>
          {t('project.export')}
        </button>
        <button type="button" disabled={busy} onClick={() => void download(false)}>
          {t('project.exportNoFlows')}
        </button>
        <label className="import-button">
          {t('project.import')}
          <input
            type="file"
            accept=".json,application/json"
            aria-label={t('project.import')}
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Importing throws away the open project, so ask first.
              if (file && window.confirm(t('project.confirmImport'))) {
                void upload(file);
              }
              event.target.value = '';
            }}
          />
        </label>
      </div>

      {note && <p className="muted">{renderMessage(note, t)}</p>}
      {error && <div className="banner error">{renderMessage(error, t)}</div>}
    </section>
  );
}

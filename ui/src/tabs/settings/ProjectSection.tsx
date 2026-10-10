/** Saving and restoring the whole capture. */

import { useState } from 'react';
import {
  exportProject,
  getLockdown,
  importProjectFile,
  downloadProjectBackup,
  restartProjectEngine,
  isDesktop,
  saveDesktopProjectFile,
} from '../../api/client';
import { notifyLockdownChanged } from '../../lockdownEvents';
import { resetUpdates } from '../../updates';
import { flushAutosaves, replaceWorkspace } from '../autosave';
import type { Project } from '../../projects';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Spinner } from '../../components/Spinner';
import {
  msg,
  rawMsg,
  renderMessage,
  useI18n,
  type Message,
} from '../../i18n';

interface ProjectSectionProps {
  project?: Project | null;
  onSwitchProject?: () => Promise<void>;
  switchingProject?: boolean;
  switchError?: string | null;
  onProjectImported?: () => void;
}

/** Export and import, plus a reminder that work is saved as you go. */
export function ProjectSection({ project, onSwitchProject, switchingProject = false, switchError, onProjectImported }: ProjectSectionProps = {}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [activeExport, setActiveExport] = useState<'database' | 'json' | 'noFlows' | null>(null);
  const [note, setNote] = useState<Message | null>(null);
  const [error, setError] = useState<Message | null>(null);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);

  const download = async (includeFlows: boolean, database = false) => {
    setActiveExport(database ? 'database' : includeFlows ? 'json' : 'noFlows');
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await flushAutosaves();
      const stamp = new Date().toISOString().slice(0, 10);
      const filename = database ? 'lanius-project.sqlite' : `lanius-${stamp}.lanius.json`;
      if (isDesktop()) {
        const path = await saveDesktopProjectFile(
          database ? 'database' : 'json', includeFlows, filename,
          t(database ? 'project.backupDatabase' : includeFlows ? 'project.export' : 'project.exportNoFlows'),
        );
        if (path) setNote(msg('project.savedFile', { path }));
        return;
      }
      const blob = database ? await downloadProjectBackup()
        : new Blob([JSON.stringify(await exportProject(includeFlows), null, 2)], {
          type: 'application/json',
        });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      // Revoking immediately can cancel the download in some browsers.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      setError(rawMsg((err as Error).message));
    } finally {
      setActiveExport(null);
      setBusy(false);
    }
  };

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const result = await replaceWorkspace(() => importProjectFile(file));
      onProjectImported?.();
      setNote(
        msg('project.imported', {
          flows: String(result.flows ?? 0),
          scope: String(result.scope ?? 0),
        }),
      );
      if (result.warnings?.length) setError(rawMsg(result.warnings.join('; ')));
      try {
        const lockdown = await getLockdown();
        if (lockdown.effective) resetUpdates();
        if (lockdown.project_enabled) await restartProjectEngine();
      } catch (err) {
        setError(rawMsg(String(err instanceof Error ? err.message : err)));
      } finally {
        notifyLockdownChanged();
      }
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

      {project && onSwitchProject && (
        <div className="project-current">
          <span>
            {t('project.current')}: <strong>{project.id === 'legacy'
              ? t('startup.legacyName')
              : project.temporary ? t('startup.tempName') : project.name}</strong>
          </span>
          <button
            type="button"
            disabled={busy || switchingProject}
            onClick={() => setSwitchOpen(true)}
          >
            {t('startup.switch')}
          </button>
        </div>
      )}
      {switchError && <div className="banner error" role="alert">{switchError}</div>}

      <div className="project-actions">
        <button type="button" disabled={busy} aria-busy={activeExport === 'database'} aria-label={t('project.backupDatabase')} onClick={() => void download(true, true)}>
          {activeExport === 'database' && <Spinner label={t('project.working')} />}
          {t('project.backupDatabase')}
        </button>
        <button type="button" disabled={busy} aria-busy={activeExport === 'json'} aria-label={t('project.export')} onClick={() => void download(true)}>
          {activeExport === 'json' && <Spinner label={t('project.working')} />}
          {t('project.export')}
        </button>
        <button type="button" disabled={busy} aria-busy={activeExport === 'noFlows'} aria-label={t('project.exportNoFlows')} onClick={() => void download(false)}>
          {activeExport === 'noFlows' && <Spinner label={t('project.working')} />}
          {t('project.exportNoFlows')}
        </button>
        <label className="import-button">
          {t('project.import')}
          <input
            type="file"
            accept=".json,.sqlite,.sqlite3,.db,application/json,application/x-sqlite3"
            aria-label={t('project.import')}
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) setImportFile(file);
              event.target.value = '';
            }}
          />
        </label>
      </div>

      {busy && activeExport === null && <p className="project-file-progress"><Spinner label={t('project.working')} />{t('project.working')}</p>}
      {note && <p className="muted">{renderMessage(note, t)}</p>}
      {error && <div className="banner error">{renderMessage(error, t)}</div>}
      <ConfirmDialog
        open={switchOpen}
        title={t('startup.switch')}
        message={t(project?.temporary ? 'project.confirmSwitchTemp' : 'project.confirmSwitch')}
        confirmLabel={t('startup.switch')}
        onCancel={() => setSwitchOpen(false)}
        onConfirm={() => {
          setSwitchOpen(false);
          void onSwitchProject?.();
        }}
      />
      <ConfirmDialog
        open={importFile !== null}
        title={t('project.import')}
        message={t('project.confirmImport')}
        confirmLabel={t('project.import')}
        onCancel={() => setImportFile(null)}
        onConfirm={() => {
          if (importFile) void upload(importFile);
          setImportFile(null);
        }}
      />
    </section>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { API_BASE, getGlobalLockdown, openDirectory, pickDirectory, setDesktopApiPort, setGlobalLockdown, type GlobalLockdownStatus } from './api/client';
import { useT, type TranslationKey } from './i18n';
import {
  closeProject,
  createProject,
  deleteProject,
  getStartupProgress,
  listProjects,
  openProject,
  pendingMigration,
  renameProject,
  startTempProject,
  type PendingMigration,
  type Project,
  type StartupProgress,
} from './projects';
import './ProjectPicker.css';
import { UndoableInput } from './components/UndoableText';
import { StartupDoctor } from './StartupDoctor';
import { Spinner } from './components/Spinner';
import { ConfirmDialog } from './components/ConfirmDialog';
import { TextPromptDialog } from './components/TextPromptDialog';
import { ContextMenu, useContextMenu } from './components/ContextMenu';
import { formatBytes } from './tabs/dashboardModel';
import { useToast } from './components/Toast';
import { SettingsFileDropOverlay } from './components/SettingsFileDrop';
import { useSettingsFileDrop } from './components/useSettingsFileDrop';
import {
  applySettingsImport,
  inspectSettingsFile,
  settingsImportConfirmation,
  settingsImportError,
  settingsImportSuccess,
  settingsProjectName,
  type SettingsImportCandidate,
} from './settingsImport';

/** How often the picker asks the shell what the starting engine is doing. */
const PROGRESS_POLL_MS = 300;

/** The shell rejects with plain strings; wrapped errors would read "Error: …". */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The folder holding a project's database, for either path separator. */
function projectFolder(project: Project): string {
  return project.dbPath.replace(/[\\/][^\\/]*$/, '');
}

const STAGES: Record<string, TranslationKey> = {
  checking: 'startup.progress.checking',
  launching: 'startup.progress.launching',
  database: 'startup.progress.database',
  migrating: 'startup.progress.migrating',
  engine: 'startup.progress.engine',
  proxy: 'startup.progress.proxy',
  api: 'startup.progress.api',
};

export function ProjectPicker({ onOpen }: { onOpen: (project: Project) => void }) {
  const t = useT();
  const { showToast } = useToast();
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState('');
  const [location, setLocation] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPort, setCurrentPort] = useState(new URL(API_BASE).port);
  const [port, setPort] = useState(currentPort);
  const [portNote, setPortNote] = useState(false);
  const [lockdownGlobal, setLockdownGlobal] = useState<GlobalLockdownStatus | null>(null);
  const [doctorOpen, setDoctorOpen] = useState(false);
  // Remounting the doctor runs it again.
  const [doctorRun, setDoctorRun] = useState(0);
  // The last error came from starting a project, where the doctor can help.
  const [openFailed, setOpenFailed] = useState(false);
  const projectMenu = useContextMenu<Project>();
  const [renaming, setRenaming] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const [opening, setOpening] = useState(false);
  const [progress, setProgress] = useState<StartupProgress | null>(null);
  const [upgrade, setUpgrade] = useState<{ project: Project; migration: PendingMigration } | null>(null);
  const [settingsImport, setSettingsImport] = useState<SettingsImportCandidate | null>(null);

  const queueSettingsImport = useCallback((file: File) => {
    setError(null);
    void inspectSettingsFile(file)
      .then(setSettingsImport)
      .catch((reason: unknown) => setError(settingsImportError(reason, t)));
  }, [t]);
  const settingsDropActive = useSettingsFileDrop(queueSettingsImport, busy || opening);

  useEffect(() => {
    if (!opening) return;
    let cancelled = false;
    const poll = () => {
      void getStartupProgress()
        .then((next) => { if (!cancelled && next) setProgress(next); })
        .catch(() => undefined);
    };
    poll();
    const timer = window.setInterval(poll, PROGRESS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [opening]);

  useEffect(() => {
    void listProjects()
      .then(setProjects)
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    void getGlobalLockdown()
      .then(setLockdownGlobal)
      .catch((err: unknown) => setError(errorText(err)));
  }, []);

  const toggleGlobalLockdown = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setLockdownGlobal(await setGlobalLockdown(enabled));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const start = async (action: () => Promise<Project>) => {
    setBusy(true);
    setOpening(true);
    setProgress(null);
    setError(null);
    setOpenFailed(false);
    try {
      onOpen(await action());
    } catch (err) {
      setError(errorText(err));
      setOpenFailed(true);
      setBusy(false);
      setOpening(false);
    }
  };

  const startFromSettings = async (candidate: SettingsImportCandidate, projectName: string) => {
    setBusy(true);
    setOpening(true);
    setProgress(null);
    setError(null);
    let created = false;
    try {
      const project = await createProject(projectName);
      created = true;
      const { result, warning } = await applySettingsImport(candidate.file);
      const message = settingsImportSuccess(result, t);
      showToast({
        message: warning ? `${message} ${warning}` : message,
        tone: warning ? 'info' : 'success',
        category: 'project',
      });
      onOpen(project);
    } catch (reason) {
      if (created) {
        try {
          await closeProject();
          setProjects(await listProjects());
        } catch {
          // Preserve the import error below. The shell reports any still-open
          // project when the user retries or restarts.
        }
      }
      setError(settingsImportError(reason, t));
      setBusy(false);
      setOpening(false);
    }
  };

  /** Open a saved project, asking first if its database must be upgraded. */
  const open = async (project: Project) => {
    setBusy(true);
    setOpening(true);
    setProgress(null);
    setError(null);
    setOpenFailed(false);
    try {
      onOpen(await openProject(project.id));
    } catch (err) {
      const migration = pendingMigration(err);
      if (migration) setUpgrade({ project, migration });
      else {
        setError(errorText(err));
        setOpenFailed(true);
      }
      setBusy(false);
      setOpening(false);
    }
  };

  const stage = progress?.stage ?? 'launching';
  const stageText = t(STAGES[stage] ?? 'startup.progress.launching', {
    version: String(progress?.version ?? ''),
    target: String(progress?.target ?? ''),
  });

  const chooseLocation = async () => {
    setError(null);
    try {
      const picked = await pickDirectory(t('startup.locationPickTitle'), location ?? undefined);
      if (picked) setLocation(picked);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const applyPort = async () => {
    const wanted = Number(port);
    if (!Number.isInteger(wanted) || wanted < 1 || wanted > 65535) {
      setError(t('mcp.portInvalid'));
      return;
    }
    setBusy(true);
    setError(null);
    setPortNote(false);
    try {
      await setDesktopApiPort(wanted);
      setCurrentPort(String(wanted));
      setPortNote(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const runDoctor = () => {
    setDoctorOpen(true);
    setDoctorRun((run) => run + 1);
    window.requestAnimationFrame(() => {
      document.querySelector('.project-picker .startup-doctor')?.scrollIntoView?.({ block: 'nearest' });
    });
  };

  const manage = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setOpenFailed(false);
    try {
      await work();
      setProjects(await listProjects());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const revealProject = async (project: Project) => {
    setError(null);
    try {
      await openDirectory(projectFolder(project));
    } catch (err) {
      setError(errorText(err));
    }
  };

  const importedProjectName = settingsImport
    ? settingsProjectName(settingsImport.file.name, projects.map((project) => project.name))
    : '';

  return (
    <div className="project-picker">
      <SettingsFileDropOverlay active={settingsDropActive} />
      {opening && <div className="project-picker-opening">
        <div className="project-picker-opening-card" aria-live="polite">
          <Spinner label={stageText} />
          <div>
            <strong>{stageText}</strong>
            {progress && <span className="muted">
              {t('startup.progress.elapsed', { seconds: String(Math.floor(progress.elapsed_ms / 1000)) })}
            </span>}
            {stage === 'migrating' && <p className="muted">{t('startup.progress.migratingHelp')}</p>}
          </div>
        </div>
      </div>}
      <ConfirmDialog
        open={upgrade !== null}
        title={t('startup.migration.title')}
        message={upgrade ? t('startup.migration.message', {
          name: upgrade.project.id === 'legacy' ? t('startup.legacyName') : upgrade.project.name,
          size: formatBytes(upgrade.migration.size_bytes),
          current: String(upgrade.migration.current),
          target: String(upgrade.migration.target),
        }) : ''}
        confirmLabel={t('startup.migration.confirm')}
        onConfirm={() => {
          const project = upgrade?.project;
          setUpgrade(null);
          if (project) void start(() => openProject(project.id, true));
        }}
        onCancel={() => setUpgrade(null)}
      />
      <ConfirmDialog
        open={settingsImport !== null}
        title={t('project.importSettings')}
        message={settingsImport
          ? settingsImportConfirmation(settingsImport, t, importedProjectName)
          : ''}
        confirmLabel={t('project.importSettings')}
        onConfirm={() => {
          const candidate = settingsImport;
          const projectName = importedProjectName;
          setSettingsImport(null);
          if (candidate) void startFromSettings(candidate, projectName);
        }}
        onCancel={() => setSettingsImport(null)}
      />
      {renaming && <TextPromptDialog
        open
        title={t('startup.renameTitle')}
        label={t('startup.name')}
        initialValue={renaming.name}
        confirmLabel={t('startup.rename')}
        onConfirm={(value) => {
          const project = renaming;
          setRenaming(null);
          if (project && value !== project.name) void manage(() => renameProject(project.id, value));
        }}
        onCancel={() => setRenaming(null)}
      />}
      <ConfirmDialog
        open={deleting !== null}
        title={t(deleting?.external ? 'startup.removeTitle' : 'startup.deleteTitle')}
        message={deleting
          ? deleting.external
            ? t('startup.removeMessage', { name: deleting.name, folder: projectFolder(deleting) })
            : t('startup.deleteMessage', { name: deleting.name })
          : ''}
        confirmLabel={t(deleting?.external ? 'startup.remove' : 'startup.delete')}
        onConfirm={() => {
          const project = deleting;
          setDeleting(null);
          if (project) void manage(() => deleteProject(project.id));
        }}
        onCancel={() => setDeleting(null)}
      />
      <ContextMenu
        position={projectMenu.position}
        items={projectMenu.target ? [
          { label: t('startup.rename'), disabled: busy, onSelect: () => setRenaming(projectMenu.target) },
          { label: t('startup.showFolder'), onSelect: () => { if (projectMenu.target) void revealProject(projectMenu.target); } },
          {
            label: t(projectMenu.target.external ? 'startup.remove' : 'startup.delete'),
            separator: true,
            disabled: busy,
            onSelect: () => setDeleting(projectMenu.target),
          },
        ] : []}
        onClose={projectMenu.close}
      />
      <div className="project-picker-main">
        <div className="project-picker-brand">Lanius</div>
        <h1>{t('startup.title')}</h1>
        <p className="muted">{t('startup.intro')}</p>

        {error && <div className="banner error project-picker-error" role="alert">
          {error}
          {openFailed && <div className="project-picker-error-actions">
            <button type="button" onClick={runDoctor}>{t('startup.runDoctor')}</button>
          </div>}
        </div>}

        <label className="project-picker-lockdown lockdown-label">
          <input
            type="checkbox"
            checked={lockdownGlobal?.enabled ?? false}
            disabled={busy || lockdownGlobal === null || lockdownGlobal.forced}
            onChange={(event) => void toggleGlobalLockdown(event.target.checked)}
          />{' '}
          {t('lockdown.global')}
        </label>
        <p className="muted">{lockdownGlobal?.forced ? t('lockdown.forced') : t('lockdown.globalHelp')}</p>

        <div className="project-picker-doctor">
          <button type="button" disabled={busy} aria-expanded={doctorOpen} onClick={() => setDoctorOpen((open) => !open)}>
            {t('startup.doctor')}
          </button>
          <span className="muted">{t('startup.doctorHelp')}</span>
        </div>
        {doctorOpen && <StartupDoctor key={doctorRun} />}

        <div className="project-picker-grid">
          <section className="project-picker-card">
            <h2>{t('startup.tempTitle')}</h2>
            <p className="muted">{t('startup.tempHelp')}</p>
            <button disabled={busy} onClick={() => void start(startTempProject)}>
              {opening ? t('startup.starting') : t('startup.tempStart')}
            </button>
          </section>

          <form
            className="project-picker-card"
            onSubmit={(event) => {
              event.preventDefault();
              void start(() => createProject(name, location));
            }}
          >
            <h2>{t('startup.newTitle')}</h2>
            <p className="muted">{t('startup.newHelp')}</p>
            <label htmlFor="project-name">{t('startup.name')}</label>
            <UndoableInput
              id="project-name"
              value={name}
              maxLength={80}
              onValueChange={setName}
              placeholder={t('startup.namePlaceholder')}
            />
            <span className="project-picker-location-label">{t('startup.location')}</span>
            <div className="project-picker-location">
              <span className={location ? 'mono' : 'muted'} title={location ?? undefined}>
                {location ?? t('startup.locationDefault')}
              </span>
              <button type="button" disabled={busy} onClick={() => void chooseLocation()}>
                {t('startup.locationChoose')}
              </button>
              {location && <button type="button" disabled={busy} onClick={() => setLocation(null)}>
                {t('startup.locationReset')}
              </button>}
            </div>
            {location && <p className="muted project-picker-location-help">{t('startup.locationHelp')}</p>}
            <button type="submit" disabled={busy || !name.trim()}>
              {opening ? t('startup.starting') : t('startup.createStart')}
            </button>
          </form>
        </div>

        <section className="project-picker-import">
          <div>
            <h2>{t('startup.importSettings')}</h2>
            <p className="muted">{t('startup.importSettingsHelp')}</p>
          </div>
          <label className="import-button" aria-disabled={busy}>
            {t('project.importSettings')}
            <input
              type="file"
              accept=".json,application/json"
              aria-label={t('project.importSettings')}
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) queueSettingsImport(file);
                event.target.value = '';
              }}
            />
          </label>
        </section>



        <section className="project-picker-existing">
          <h2>{t('startup.existingTitle')}</h2>
          {loading ? <p className="muted">{t('startup.loading')}</p> :
            projects.length === 0 ? <p className="muted">{t('startup.noProjects')}</p> :
              <ul>
                {projects.map((project) => (
                  <li key={project.id}
                    onContextMenu={project.id === 'legacy' ? undefined : (event) => projectMenu.open(event, project)}>
                    <div>
                      <strong>{project.id === 'legacy' ? t('startup.legacyName') : project.name}</strong>
                      <span className="muted mono" title={project.dbPath}>{project.dbPath}</span>
                      {project.lastOpened > 0 && <span className="muted">
                        {t('startup.lastOpened', { when: new Date(project.lastOpened * 1000).toLocaleString() })}
                      </span>}
                    </div>
                    <div className="project-picker-row-actions">
                      <button disabled={busy} onClick={() => void open(project)}>
                        {opening ? t('startup.starting') : t('startup.open')}
                      </button>
                      {project.id !== 'legacy' && <button
                        type="button"
                        className="project-picker-more"
                        aria-label={t('startup.projectActions', { name: project.name })}
                        aria-haspopup="menu"
                        onClick={(event) => projectMenu.open(event, project)}
                      >⋯</button>}
                    </div>
                  </li>
                ))}
              </ul>}
        </section>

        <details className="project-picker-advanced">
          <summary>{t('startup.advanced')}</summary>
          <p className="muted">{t('startup.portNotProxy')}</p>
          <div className="project-picker-port">
            <label htmlFor="startup-api-port">{t('mcp.port')}</label>
            <UndoableInput
              id="startup-api-port"
              type="number"
              min="1"
              max="65535"
              value={port}
              disabled={busy}
              onValueChange={setPort}
            />
            <button type="button" disabled={busy || port === currentPort} onClick={() => void applyPort()}>
              {t('mcp.applyPort')}
            </button>
            <span className="muted">{portNote ? t('startup.portApplied') : t('startup.portHelp')}</span>
          </div>
        </details>
      </div>
    </div>
  );
}

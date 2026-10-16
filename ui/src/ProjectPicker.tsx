import { useEffect, useState } from 'react';
import { API_BASE, getGlobalLockdown, setDesktopApiPort, setGlobalLockdown, type GlobalLockdownStatus } from './api/client';
import { useT, type TranslationKey } from './i18n';
import {
  createProject,
  getStartupProgress,
  listProjects,
  openProject,
  pendingMigration,
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
import { formatBytes } from './tabs/dashboardModel';

/** How often the picker asks the shell what the starting engine is doing. */
const PROGRESS_POLL_MS = 300;

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
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPort, setCurrentPort] = useState(new URL(API_BASE).port);
  const [port, setPort] = useState(currentPort);
  const [portNote, setPortNote] = useState(false);
  const [lockdownGlobal, setLockdownGlobal] = useState<GlobalLockdownStatus | null>(null);
  const [doctorOpen, setDoctorOpen] = useState(false);
  const [opening, setOpening] = useState(false);
  const [progress, setProgress] = useState<StartupProgress | null>(null);
  const [upgrade, setUpgrade] = useState<{ project: Project; migration: PendingMigration } | null>(null);

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
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    void getGlobalLockdown()
      .then(setLockdownGlobal)
      .catch((err: unknown) => setError(String(err)));
  }, []);

  const toggleGlobalLockdown = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setLockdownGlobal(await setGlobalLockdown(enabled));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const start = async (action: () => Promise<Project>) => {
    setBusy(true);
    setOpening(true);
    setProgress(null);
    setError(null);
    try {
      onOpen(await action());
    } catch (err) {
      setError(String(err));
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
    try {
      onOpen(await openProject(project.id));
    } catch (err) {
      const migration = pendingMigration(err);
      if (migration) setUpgrade({ project, migration });
      else setError(String(err));
      setBusy(false);
      setOpening(false);
    }
  };

  const stage = progress?.stage ?? 'launching';
  const stageText = t(STAGES[stage] ?? 'startup.progress.launching', {
    version: String(progress?.version ?? ''),
    target: String(progress?.target ?? ''),
  });

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
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="project-picker">
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
      <div className="project-picker-main">
        <div className="project-picker-brand">Lanius</div>
        <h1>{t('startup.title')}</h1>
        <p className="muted">{t('startup.intro')}</p>

        {error && <div className="banner error project-picker-error" role="alert">{error}</div>}

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

        <div className="project-picker-doctor">
          <button type="button" disabled={busy} aria-expanded={doctorOpen} onClick={() => setDoctorOpen((open) => !open)}>
            {t('startup.doctor')}
          </button>
          <span className="muted">{t('startup.doctorHelp')}</span>
        </div>
        {doctorOpen && <StartupDoctor />}

        <div className="project-picker-grid">
          <section className="project-picker-card">
            <h2>{t('startup.tempTitle')}</h2>
            <p className="muted">{t('startup.tempHelp')}</p>
            <button disabled={busy} onClick={() => void start(startTempProject)}>
              {busy ? t('startup.starting') : t('startup.tempStart')}
            </button>
          </section>

          <form
            className="project-picker-card"
            onSubmit={(event) => {
              event.preventDefault();
              void start(() => createProject(name));
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
            <button type="submit" disabled={busy || !name.trim()}>
              {busy ? t('startup.starting') : t('startup.createStart')}
            </button>
          </form>
        </div>

        <section className="project-picker-existing">
          <h2>{t('startup.existingTitle')}</h2>
          {loading ? <p className="muted">{t('startup.loading')}</p> :
            projects.length === 0 ? <p className="muted">{t('startup.noProjects')}</p> :
              <ul>
                {projects.map((project) => (
                  <li key={project.id}>
                    <div>
                      <strong>{project.id === 'legacy' ? t('startup.legacyName') : project.name}</strong>
                      <span className="muted mono">{project.dbPath}</span>
                    </div>
                    <button disabled={busy} onClick={() => void open(project)}>
                      {busy ? t('startup.starting') : t('startup.open')}
                    </button>
                  </li>
                ))}
              </ul>}
        </section>
      </div>
    </div>
  );
}

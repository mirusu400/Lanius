import { useEffect, useState } from 'react';
import { API_BASE, getGlobalLockdown, setDesktopApiPort, setGlobalLockdown, type GlobalLockdownStatus } from './api/client';
import { useT } from './i18n';
import {
  createProject,
  listProjects,
  openProject,
  startTempProject,
  type Project,
} from './projects';
import './ProjectPicker.css';

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
    setError(null);
    try {
      onOpen(await action());
    } catch (err) {
      setError(String(err));
      setBusy(false);
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
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="project-picker">
      <div className="project-picker-main">
        <div className="project-picker-brand">Lanius</div>
        <h1>{t('startup.title')}</h1>
        <p className="muted">{t('startup.intro')}</p>

        {error && <div className="banner error" role="alert">{error}</div>}

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
          <input
            id="startup-api-port"
            type="number"
            min="1"
            max="65535"
            value={port}
            disabled={busy}
            onChange={(event) => setPort(event.target.value)}
          />
          <button type="button" disabled={busy || port === currentPort} onClick={() => void applyPort()}>
            {t('mcp.applyPort')}
          </button>
          <span className="muted">{portNote ? t('startup.portApplied') : t('startup.portHelp')}</span>
        </div>

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
            <input
              id="project-name"
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
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
                    <button disabled={busy} onClick={() => void start(() => openProject(project.id))}>
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

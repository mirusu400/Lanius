import { useEffect, useState } from 'react';
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

  useEffect(() => {
    void listProjects()
      .then(setProjects)
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setLoading(false));
  }, []);

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

  return (
    <div className="project-picker">
      <div className="project-picker-main">
        <div className="project-picker-brand">Lanius</div>
        <h1>{t('startup.title')}</h1>
        <p className="muted">{t('startup.intro')}</p>

        {error && <div className="banner error" role="alert">{error}</div>}

        <div className="project-picker-grid">
          <section className="project-picker-card">
            <h2>{t('startup.tempTitle')}</h2>
            <p className="muted">{t('startup.tempHelp')}</p>
            <button disabled={busy} onClick={() => void start(startTempProject)}>
              {t('startup.tempStart')}
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
              {t('startup.createStart')}
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
                      {t('startup.open')}
                    </button>
                  </li>
                ))}
              </ul>}
        </section>
      </div>
    </div>
  );
}

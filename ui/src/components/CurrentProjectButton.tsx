import type { Project } from '../projects';
import { useT } from '../i18n';

export function CurrentProjectButton({ project, onOpen }: {
  project: Project;
  onOpen: () => void;
}) {
  const t = useT();
  const name = project.id === 'legacy'
    ? t('startup.legacyName')
    : project.temporary ? t('startup.tempName') : project.name;
  const label = `${t('project.current')}: ${name}`;
  return (
    <button
      type="button"
      className="project-pill"
      aria-label={label}
      title={`${label}\n${project.dbPath}`}
      onClick={onOpen}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M2.25 3.25h4l1.2 1.5h6.3v8H2.25z" />
      </svg>
      <span>{name}</span>
    </button>
  );
}

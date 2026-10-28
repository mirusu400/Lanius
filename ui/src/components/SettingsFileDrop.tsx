import { useT } from '../i18n';

export function SettingsFileDropOverlay({ active }: { active: boolean }) {
  const t = useT();
  if (!active) return null;
  return <div className="settings-file-drop-overlay" role="status">
    <div>{t('project.dropSettings')}</div>
    <span>{t('project.dropSettingsHelp')}</span>
  </div>;
}

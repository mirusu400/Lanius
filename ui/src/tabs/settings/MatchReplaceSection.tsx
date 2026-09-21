import { MatchReplaceButton } from '../../components/MatchReplaceDialog';
import { useT } from '../../i18n';

export function MatchReplaceSection() {
  const t = useT();
  return (
    <section>
      <h3>{t('matchReplace.title')}</h3>
      <p className="muted">{t('matchReplace.help')}</p>
      <div className="settings-row"><MatchReplaceButton /></div>
    </section>
  );
}

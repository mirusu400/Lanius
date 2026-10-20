import { useT } from '../../i18n';
import { useToast } from '../../components/Toast';
import { useSettingsToast } from '../../components/useSettingsToast';
import { defaultToastPreferences, TOAST_CATEGORIES, type ToastPreferences } from '../../toastPreferences';

export function ToastSection() {
  const t = useT();
  const { preferences, updatePreferences } = useToast();
  const saved = useSettingsToast('toast.section');
  const update = (next: ToastPreferences) => saved({ persisted: updatePreferences(next) });
  return <section>
    <h3>{t('toast.section')}</h3>
    <p className="muted">{t('toast.help')}</p>
    {TOAST_CATEGORIES.map((category) => <div className="settings-row" key={category}>
      <label><input type="checkbox" checked={preferences[category]}
        onChange={(event) => update({ ...preferences, [category]: event.target.checked })} />{' '}
        {t(`toast.category.${category}`)}</label>
    </div>)}
    <p className="muted">{t('toast.errorsAlways')}</p>
    <button type="button" onClick={() => update(defaultToastPreferences())}>{t('toast.reset')}</button>
  </section>;
}

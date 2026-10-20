/** Interface language. */

import { LOCALES, LOCALE_NAMES, makeTranslator, useI18n, type Locale } from '../../i18n';
import { useToast } from '../../components/Toast';

export function LanguageSection() {
  const { t, locale, setLocale } = useI18n();
  const { showToast } = useToast();
  return (
    <section>
      <h3>{t('settings.languageSection')}</h3>
      <div className="settings-row">
        <label htmlFor="locale-select">{t('settings.language')}</label>
        <select
          id="locale-select"
          aria-label={t('settings.language')}
          value={locale}
          onChange={(e) => {
            const next = e.target.value as Locale;
            const persisted = setLocale(next);
            const translate = makeTranslator(next);
            showToast({ message: translate(persisted ? 'toast.settingsApplied' : 'toast.settingsSessionOnly',
              { section: translate('settings.languageSection') }),
              tone: persisted ? 'success' : 'info', category: 'settings', id: 'settings:language' });
          }}
        >
          {LOCALES.map((code) => (
            <option key={code} value={code}>
              {LOCALE_NAMES[code]}
            </option>
          ))}
        </select>
      </div>
      <p className="muted">{t('settings.languageHelp')}</p>
    </section>
  );
}

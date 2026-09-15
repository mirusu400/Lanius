/** Interface language. */

import { LOCALES, LOCALE_NAMES, useI18n, type Locale } from '../../i18n';

export function LanguageSection() {
  const { t, locale, setLocale } = useI18n();
  return (
    <section>
      <h3>{t('settings.languageSection')}</h3>
      <div className="settings-row">
        <label htmlFor="locale-select">{t('settings.language')}</label>
        <select
          id="locale-select"
          aria-label={t('settings.language')}
          value={locale}
          onChange={(e) => setLocale(e.target.value as Locale)}
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

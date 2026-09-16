/** Theme and fonts. */

import { useEffect, useState } from 'react';
import {
  DEFAULTS as APPEARANCE_DEFAULTS,
  MONO_FAMILIES,
  MONO_SIZE_PRESETS,
  MONO_SIZE_RANGE,
  UI_FAMILIES,
  UI_SIZE_PRESETS,
  UI_SIZE_RANGE,
  apply as applyAppearance,
  fontAvailable,
  load as loadAppearance,
  normalise as normaliseAppearance,
  primaryFamily,
  save as saveAppearance,
  stackOf,
  watchSystem,
  type Appearance,
  type ThemeChoice,
} from '../../appearance';
import {
  useI18n,
} from '../../i18n';
import { SizeField } from '../../components/SizeField';

/** Turns OS-level capture on and off. Kept separate because it owns its
 *  own request state and does not share anything with the rest of the tab. */
export function AppearanceSection() {
  const { t } = useI18n();
  const [settings, setSettings] = useState<Appearance>(() => loadAppearance());

  const update = (patch: Partial<Appearance>) => {
    const next = normaliseAppearance({ ...settings, ...patch });
    setSettings(next);
    applyAppearance(next);
    saveAppearance(next);
  };

  // Following the system means reacting when the system changes.
  useEffect(() => {
    if (settings.theme !== 'system') return;
    return watchSystem(() => applyAppearance(settings));
  }, [settings]);

  const monoStack = stackOf(MONO_FAMILIES, settings.monoFamily);
  const uiStack = stackOf(UI_FAMILIES, settings.uiFamily);
  // A missing font falls back silently, which looks like the setting
  // being ignored; say so instead.
  const monoMissing = !fontAvailable(primaryFamily(monoStack));
  const uiMissing = !fontAvailable(primaryFamily(uiStack));

  const fontLabel = (id: string, stack: string) =>
    id === '' ? t('appearance.fontDefault') : primaryFamily(stack);

  return (
    <section>
      <h3>{t('appearance.section')}</h3>
      <p className="muted">{t('appearance.help')}</p>

      <div className="settings-row">
        <label htmlFor="theme-select">{t('appearance.theme')}</label>
        <select
          id="theme-select"
          value={settings.theme}
          onChange={(event) =>
            update({ theme: event.target.value as ThemeChoice })
          }
        >
          <option value="system">{t('appearance.themeSystem')}</option>
          <option value="dark">{t('appearance.themeDark')}</option>
          <option value="light">{t('appearance.themeLight')}</option>
        </select>
      </div>

      <div className="settings-row">
        <label htmlFor="ui-font">{t('appearance.uiFont')}</label>
        <select
          id="ui-font"
          value={settings.uiFamily}
          onChange={(event) => update({ uiFamily: event.target.value })}
        >
          {UI_FAMILIES.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {fontLabel(entry.id, entry.stack)}
            </option>
          ))}
        </select>
        {uiMissing && <span className="muted">{t('appearance.missingFont')}</span>}
      </div>

      <div className="settings-row">
        <label htmlFor="ui-size">{t('appearance.uiSize')}</label>
        <SizeField
          id="ui-size"
          value={settings.uiSize}
          min={UI_SIZE_RANGE.min}
          max={UI_SIZE_RANGE.max}
          presets={UI_SIZE_PRESETS}
          onChange={(uiSize) => update({ uiSize })}
        />
      </div>

      <div className="settings-row">
        <label htmlFor="mono-font">{t('appearance.monoFont')}</label>
        <select
          id="mono-font"
          value={settings.monoFamily}
          onChange={(event) => update({ monoFamily: event.target.value })}
        >
          {MONO_FAMILIES.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {fontLabel(entry.id, entry.stack)}
            </option>
          ))}
        </select>
        {monoMissing && (
          <span className="muted">{t('appearance.missingFont')}</span>
        )}
      </div>

      <div className="settings-row">
        <label htmlFor="mono-size">{t('appearance.monoSize')}</label>
        <SizeField
          id="mono-size"
          value={settings.monoSize}
          min={MONO_SIZE_RANGE.min}
          max={MONO_SIZE_RANGE.max}
          presets={MONO_SIZE_PRESETS}
          onChange={(monoSize) => update({ monoSize })}
        />
      </div>

      {/* Shown in the chosen font at the chosen size, so the effect is
          visible without hunting for an editor. */}
      <pre className="appearance-preview mono" aria-label={t('appearance.previewLabel')}>
        {t('appearance.preview')}
      </pre>

      <div className="settings-row">
        <button type="button" onClick={() => update(APPEARANCE_DEFAULTS)}>
          {t('appearance.reset')}
        </button>
      </div>
    </section>
  );
}

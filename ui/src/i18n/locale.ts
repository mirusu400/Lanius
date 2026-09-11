/** Locale state: detection, persistence and interpolation. */

import {
  CATALOGUES,
  LOCALES,
  type Locale,
  type TranslationKey,
} from './catalogue';

export const STORAGE_KEY = 'lanius.locale';
export const DEFAULT_LOCALE: Locale = 'en';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** Best locale for a browser language list, e.g. ['ko-KR', 'en']. */
export function matchLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const base = language.toLowerCase().split('-')[0];
    if (isLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}

/** Saved choice wins; otherwise fall back to the browser's languages. */
export function detectLocale(
  storage?: Pick<Storage, 'getItem'>,
  languages: readonly string[] = [],
): Locale {
  try {
    const saved = storage?.getItem(STORAGE_KEY);
    if (isLocale(saved)) return saved;
  } catch {
    // storage can throw in private mode; fall through to detection
  }
  return matchLocale(languages);
}

export function saveLocale(
  locale: Locale,
  storage?: Pick<Storage, 'setItem'>,
): void {
  try {
    storage?.setItem(STORAGE_KEY, locale);
  } catch {
    // ignore: the choice still applies for this session
  }
}

/** Replace `{name}` placeholders. Unknown placeholders are left intact. */
export function interpolate(
  template: string,
  values?: Record<string, string | number>,
): string {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
}

/** Look up a key, falling back to English and then to the key itself. */
export function translate(
  locale: Locale,
  key: TranslationKey,
  values?: Record<string, string | number>,
): string {
  const template =
    CATALOGUES[locale]?.[key] ?? CATALOGUES[DEFAULT_LOCALE][key] ?? key;
  return interpolate(template, values);
}

export type Translator = (
  key: TranslationKey,
  values?: Record<string, string | number>,
) => string;

export function makeTranslator(locale: Locale): Translator {
  return (key, values) => translate(locale, key, values);
}

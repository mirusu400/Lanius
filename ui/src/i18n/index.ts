export { CATALOGUES, LOCALES, LOCALE_NAMES } from './catalogue';
export type { Locale, TranslationKey } from './catalogue';
export { I18nProvider, useI18n, useT } from './context';
export {
  DEFAULT_LOCALE,
  STORAGE_KEY,
  detectLocale,
  interpolate,
  isLocale,
  makeTranslator,
  matchLocale,
  saveLocale,
  translate,
} from './locale';
export type { Translator } from './locale';
export { ParseError, errorText } from './ParseError';

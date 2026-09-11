/** React binding for the locale. */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import type { Locale } from './catalogue';
import {
  DEFAULT_LOCALE,
  detectLocale,
  makeTranslator,
  saveLocale,
  type Translator,
} from './locale';

interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: Translator;
}

const I18nContext = createContext<I18nValue | null>(null);

function initialLocale(): Locale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE;
  return detectLocale(window.localStorage, window.navigator?.languages ?? []);
}

export function I18nProvider({
  children,
  initial,
}: {
  children: ReactNode;
  initial?: Locale;
}) {
  const [locale, setLocaleState] = useState<Locale>(
    () => initial ?? initialLocale(),
  );

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    if (typeof window !== 'undefined') saveLocale(next, window.localStorage);
  }, []);

  // Keep the document language in sync for accessibility and font selection.
  useEffect(() => {
    if (typeof document !== 'undefined') document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo<I18nValue>(
    () => ({ locale, setLocale, t: makeTranslator(locale) }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (value === null) {
    throw new Error('useI18n must be used inside <I18nProvider>');
  }
  return value;
}

/** Convenience hook for components that only need the translate function. */
export function useT(): Translator {
  return useI18n().t;
}

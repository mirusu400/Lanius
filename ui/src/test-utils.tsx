/** Test helpers: render components inside the i18n provider.
 *
 * Tests pin an explicit locale so assertions never depend on the machine's
 * browser language.
 */

import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';

import { I18nProvider, makeTranslator, type Locale, type Translator } from './i18n';

// Overridable so CI can run the whole suite in another language and prove no
// assertion depends on a hardcoded string (see `npm run test:locales`).
export const TEST_LOCALE: Locale =
  (import.meta.env?.VITE_TEST_LOCALE as Locale | undefined) ?? 'en';

/** Translate exactly like the rendered component does. */
export const t: Translator = makeTranslator(TEST_LOCALE);

export function tk(locale: Locale): Translator {
  return makeTranslator(locale);
}

export function renderWithI18n(
  ui: ReactElement,
  { locale = TEST_LOCALE, ...options }: RenderOptions & { locale?: Locale } = {},
): RenderResult {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <I18nProvider initial={locale}>{children}</I18nProvider>
  );
  return render(ui, { wrapper: Wrapper, ...options });
}

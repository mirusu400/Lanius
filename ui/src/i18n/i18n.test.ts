import { describe, expect, it } from 'vitest';

import {
  CATALOGUES,
  LOCALES,
  LOCALE_NAMES,
  type TranslationKey,
} from './catalogue';
import {
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

describe('catalogue integrity', () => {
  it('every locale defines exactly the English keys', () => {
    const reference = Object.keys(CATALOGUES.en).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(CATALOGUES[locale]).sort(), locale).toEqual(reference);
    }
  });

  it('no translation is blank', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(CATALOGUES[locale])) {
        expect(value.trim(), `${locale}.${key}`).not.toBe('');
      }
    }
  });

  it('placeholders match across locales', () => {
    const placeholders = (text: string) =>
      (text.match(/\{(\w+)\}/g) ?? []).sort().join(',');
    for (const key of Object.keys(CATALOGUES.en) as TranslationKey[]) {
      const expected = placeholders(CATALOGUES.en[key]);
      for (const locale of LOCALES) {
        expect(placeholders(CATALOGUES[locale][key]), `${locale}.${key}`).toBe(
          expected,
        );
      }
    }
  });

  it('every locale has a display name', () => {
    for (const locale of LOCALES) {
      expect(LOCALE_NAMES[locale]).toBeTruthy();
    }
  });

  it('translations actually differ between locales', () => {
    // Guards against a copy-paste catalogue that never got translated.
    const differing = (Object.keys(CATALOGUES.en) as TranslationKey[]).filter(
      (key) => CATALOGUES.en[key] !== CATALOGUES.ko[key],
    );
    expect(differing.length).toBeGreaterThan(80);
  });
});

describe('isLocale', () => {
  it('accepts known locales only', () => {
    expect(isLocale('en')).toBe(true);
    expect(isLocale('ko')).toBe(true);
    expect(isLocale('fr')).toBe(false);
    expect(isLocale(null)).toBe(false);
    expect(isLocale(42)).toBe(false);
  });
});

describe('matchLocale', () => {
  it('matches a regional tag to its base language', () => {
    expect(matchLocale(['ko-KR', 'en-US'])).toBe('ko');
    expect(matchLocale(['en-GB'])).toBe('en');
  });

  it('skips unsupported languages', () => {
    expect(matchLocale(['fr-FR', 'ko'])).toBe('ko');
  });

  it('falls back to the default', () => {
    expect(matchLocale([])).toBe(DEFAULT_LOCALE);
    expect(matchLocale(['zz'])).toBe(DEFAULT_LOCALE);
  });

  it('is case insensitive', () => {
    expect(matchLocale(['KO-kr'])).toBe('ko');
  });
});

describe('detectLocale', () => {
  const storage = (value: string | null) => ({ getItem: () => value });

  it('prefers a saved choice over the browser language', () => {
    expect(detectLocale(storage('en'), ['ko-KR'])).toBe('en');
    expect(detectLocale(storage('ko'), ['en-US'])).toBe('ko');
  });

  it('ignores a corrupted saved value', () => {
    expect(detectLocale(storage('klingon'), ['ko'])).toBe('ko');
  });

  it('falls back to browser languages when nothing is saved', () => {
    expect(detectLocale(storage(null), ['ko-KR'])).toBe('ko');
  });

  it('survives storage throwing (private mode)', () => {
    const hostile = {
      getItem() {
        throw new Error('denied');
      },
    };
    expect(detectLocale(hostile, ['ko'])).toBe('ko');
  });

  it('works with no storage at all', () => {
    expect(detectLocale(undefined, ['ko'])).toBe('ko');
  });
});

describe('saveLocale', () => {
  it('writes under the documented key', () => {
    const written: Record<string, string> = {};
    saveLocale('ko', {
      setItem: (k: string, v: string) => {
        written[k] = v;
      },
    });
    expect(written[STORAGE_KEY]).toBe('ko');
  });

  it('ignores storage failures', () => {
    expect(() =>
      saveLocale('ko', {
        setItem() {
          throw new Error('quota');
        },
      }),
    ).not.toThrow();
  });
});

describe('interpolate', () => {
  it('substitutes named placeholders', () => {
    expect(interpolate('{count} flows', { count: 3 })).toBe('3 flows');
  });

  it('substitutes repeated placeholders', () => {
    expect(interpolate('{a}-{a}', { a: 'x' })).toBe('x-x');
  });

  it('leaves unknown placeholders intact', () => {
    expect(interpolate('{a} {b}', { a: '1' })).toBe('1 {b}');
  });

  it('returns the template when no values are given', () => {
    expect(interpolate('plain text')).toBe('plain text');
  });
});

describe('translate', () => {
  it('returns the locale string', () => {
    expect(translate('en', 'common.refresh')).toBe('Refresh');
    expect(translate('ko', 'common.refresh')).toBe('새로고침');
  });

  it('interpolates values', () => {
    expect(translate('en', 'proxy.flowCount', { count: 7 })).toBe('7 flows');
    expect(translate('ko', 'proxy.flowCount', { count: 7 })).toBe('flow 7건');
  });

  it('falls back to English for an unknown locale', () => {
    // @ts-expect-error deliberately invalid at runtime
    expect(translate('fr', 'common.refresh')).toBe('Refresh');
  });

  it('returns the key when it is missing everywhere', () => {
    // @ts-expect-error deliberately unknown key
    expect(translate('en', 'nope.missing')).toBe('nope.missing');
  });
});

describe('makeTranslator', () => {
  it('binds a locale', () => {
    const t = makeTranslator('ko');
    expect(t('common.delete')).toBe('삭제');
    expect(t('intercept.queued', { count: 2 })).toBe('대기 2건');
  });
});

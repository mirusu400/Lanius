/** Error whose message is a translation key, so pure modules stay locale-free. */

import type { TranslationKey } from './catalogue';

export class ParseError extends Error {
  readonly key: TranslationKey;

  constructor(key: TranslationKey) {
    super(key);
    this.name = 'ParseError';
    this.key = key;
  }
}

/** Localise any error: ParseError via its key, anything else via its message. */
export function errorText(
  error: unknown,
  t: (key: TranslationKey) => string,
): string {
  if (error instanceof ParseError) return t(error.key);
  return error instanceof Error ? error.message : String(error);
}

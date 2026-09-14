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

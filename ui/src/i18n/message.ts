/**
 * Messages that are stored now and translated later.
 *
 * Putting a translated string into state freezes it in whatever language
 * was current when it was produced. A banner raised before the user
 * switches language then keeps explaining itself in the language they
 * have left. Keep the key and its arguments instead, and translate at
 * render time.
 */

import type { TranslationKey } from './catalogue';
import type { Translator } from './locale';
import { ParseError } from './ParseError';

/** Either a key to translate later, or text the engine already worded. */
export type Message =
  | { kind: 'key'; key: TranslationKey; vars?: Record<string, string | number> }
  | { kind: 'text'; text: string };

/** A message that must be looked up in the catalogue when it is shown. */
export function msg(
  key: TranslationKey,
  vars?: Record<string, string | number>,
): Message {
  return { kind: 'key', key, vars };
}

/** A message that is already final, such as an error from the engine. */
export function rawMsg(text: string): Message {
  return { kind: 'text', text };
}

/** Render a message in the language that is current right now. */
export function renderMessage(message: Message | null, t: Translator): string | null {
  if (message === null) return null;
  return message.kind === 'text' ? message.text : t(message.key, message.vars);
}

/**
 * Turn any thrown value into a message.
 *
 * ParseError already carries a key rather than a sentence, precisely so
 * that pure modules need not know the locale; keep it as a key here too.
 * Anything else has already been worded by whoever raised it.
 */
export function errorMessage(error: unknown): Message {
  if (error instanceof ParseError) return msg(error.key);
  return rawMsg(error instanceof Error ? error.message : String(error));
}

/**
 * Accept a message that may predate this shape.
 *
 * Projects saved before errors became messages hold a plain string, which
 * was the translated sentence. It cannot be re-translated, but showing it
 * as-is beats showing '[object Object]'.
 */
export function asMessage(value: unknown): Message | null {
  if (value == null) return null;
  if (typeof value === 'string') return rawMsg(value);
  if (typeof value === 'object' && 'kind' in value) return value as Message;
  return null;
}

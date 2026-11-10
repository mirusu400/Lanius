/** Encode and decode the selected text in place.
 *
 * Editing a request often means turning one value into the form the
 * server expects, such as percent-encoding a payload before it goes into a query
 * string. Doing that in the editor itself saves a trip through Decoder
 * and back. These run locally and synchronously, so the menu can tell
 * before it opens whether a decode would succeed.
 */

import type { TranslationKey } from '../i18n';
import type { MenuItem } from './ContextMenu';

export type Transform = (value: string) => string | null;

const UNRESERVED = /[A-Za-z0-9\-_.~]/;

function percent(byte: number): string {
  return `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
}

/** Percent-encode everything except RFC 3986 unreserved characters. */
export function urlEncodeKey(value: string): string {
  let out = '';
  for (const char of value) {
    if (UNRESERVED.test(char)) out += char;
    else out += Array.from(new TextEncoder().encode(char), percent).join('');
  }
  return out;
}

/** Percent-encode every byte, letters included. */
export function urlEncodeAll(value: string): string {
  return Array.from(new TextEncoder().encode(value), percent).join('');
}

/** Decode %XX sequences, and `+` as a space as forms send it.
 *
 * A stray `%` is left as it is rather than refusing the whole value,
 * since real requests are often only partly encoded.
 */
export function urlDecode(value: string): string {
  const bytes: number[] = [];
  for (const part of value.replace(/\+/g, ' ').split(/(%[0-9A-Fa-f]{2})/)) {
    if (/^%[0-9A-Fa-f]{2}$/.test(part)) bytes.push(parseInt(part.slice(1), 16));
    else bytes.push(...new TextEncoder().encode(part));
  }
  return bytesToText(bytes);
}

export function base64Encode(value: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64UrlEncode(value: string): string {
  return base64Encode(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Standard or URL-safe, padded or not. Null when it is not Base64. */
export function base64Decode(value: string): string | null {
  const compact = value.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!compact || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return null;
  const unpadded = compact.replace(/=+$/, '');
  if (unpadded.length % 4 === 1) return null;
  const padded = unpadded + '='.repeat((4 - (unpadded.length % 4)) % 4);
  try {
    return bytesToText(Array.from(atob(padded), (char) => char.charCodeAt(0)));
  } catch {
    return null;
  }
}

const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
};

export function htmlEncode(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ENTITIES[char]);
}

export function htmlDecode(value: string): string {
  // Textarea content is parsed as text, so markup stays as written and
  // only character references are resolved. Nothing here runs.
  const element = document.createElement('textarea');
  element.innerHTML = value;
  return element.value;
}

export function hexEncode(value: string): string {
  return Array.from(new TextEncoder().encode(value), (byte) =>
    byte.toString(16).padStart(2, '0')).join('');
}

/** Accepts `414243`, `41 42 43`, `\x41\x42` and `0x41`. */
export function hexDecode(value: string): string | null {
  const compact = value.replace(/\\x|0x|[\s:,-]/gi, '');
  if (!compact || compact.length % 2 !== 0 || !/^[0-9A-Fa-f]+$/.test(compact)) return null;
  const bytes: number[] = [];
  for (let index = 0; index < compact.length; index += 2) {
    bytes.push(parseInt(compact.slice(index, index + 2), 16));
  }
  return bytesToText(bytes);
}

/** UTF-8 when the bytes are valid UTF-8, otherwise one character per byte.
 *
 * Falling back to Latin-1 keeps every byte recoverable, where the
 * replacement character would silently lose them.
 */
function bytesToText(bytes: number[]): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return String.fromCharCode(...bytes);
  }
}

const ENCODERS: Array<[TranslationKey, Transform]> = [
  ['encode.urlKey', urlEncodeKey],
  ['encode.urlAll', urlEncodeAll],
  ['encode.base64', base64Encode],
  ['encode.base64Url', base64UrlEncode],
  ['encode.html', htmlEncode],
  ['encode.hex', hexEncode],
];

const DECODERS: Array<[TranslationKey, Transform]> = [
  ['decode.url', urlDecode],
  ['decode.base64', base64Decode],
  ['decode.html', htmlDecode],
  ['decode.hex', hexDecode],
];

/** Encode and Decode submenus acting on `text`.
 *
 * A decoder that cannot read the selection is disabled rather than
 * hidden, so the menu keeps the same shape from one selection to the next.
 */
export function encodeMenuItems(
  t: (key: TranslationKey) => string,
  text: string,
  apply: (value: string) => void,
  enabled: boolean,
): MenuItem[] {
  const build = (entries: Array<[TranslationKey, Transform]>): MenuItem[] =>
    entries.map(([label, transform]) => {
      const result = enabled && text ? transform(text) : null;
      return {
        label: t(label),
        disabled: result === null,
        onSelect: () => {
          if (result !== null) apply(result);
        },
      };
    });
  return [
    { label: t('encode.menu'), disabled: !enabled || !text, items: build(ENCODERS) },
    { label: t('decode.menu'), disabled: !enabled || !text, items: build(DECODERS) },
  ];
}

/** Put `value` where the range was, returning the new text and range. */
export function replaceRange(
  text: string,
  start: number,
  end: number,
  value: string,
): { text: string; start: number; end: number } {
  return {
    text: text.slice(0, start) + value + text.slice(end),
    start,
    end: start + value.length,
  };
}

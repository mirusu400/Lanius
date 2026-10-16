/** What the Inspector needs to know about where a selection came from. */

import { splitMessage } from './bodyFormat';
import { messageHeaders } from './syntaxLanguage';

/** Charsets that can be chosen by hand. Names match the engine's. */
export const INSPECTOR_CHARSETS: [string, string][] = [
  ['utf-8', 'UTF-8'],
  ['cp949', 'EUC-KR / CP949'],
  ['cp932', 'Shift_JIS / CP932'],
  ['euc_jp', 'EUC-JP'],
  ['gb18030', 'GB18030 / GBK'],
  ['cp950', 'Big5 / CP950'],
  ['cp1251', 'Windows-1251'],
  ['koi8-r', 'KOI8-R'],
  ['cp1252', 'Windows-1252 / Latin-1'],
];

function header(raw: string, name: string): string | null {
  const found = (messageHeaders(raw) ?? []).find(([key]) => key.toLowerCase() === name);
  return found ? found[1] : null;
}

/** The host a request goes to, from its Host header or absolute URL. */
export function requestHost(raw: string): string | null {
  const host = header(raw, 'host');
  if (host) return host.toLowerCase();
  const target = raw.split(/\r?\n/, 1)[0]?.split(' ')[1] ?? '';
  try {
    return new URL(target).host.toLowerCase() || null;
  } catch {
    return null;
  }
}

function isFormBody(raw: string): boolean {
  const type = header(raw, 'content-type') ?? '';
  return type.toLowerCase().includes('application/x-www-form-urlencoded');
}

/** Whether a selected value is form-encoded, where "+" means a space.
 *
 * That holds in the query string and in a urlencoded body. In a path or
 * a JSON body, "+" is a plus sign. With the selection's offset the answer
 * is exact; without one (a read-only view), it is where the value occurs.
 */
export function isFormValue(original: string, value: string, start?: number): boolean {
  // Offsets come from a textarea, which counts each line break as one.
  const raw = original.replace(/\r\n/g, '\n');
  const firstLineEnd = raw.search(/\r?\n/);
  const firstLine = firstLineEnd < 0 ? raw : raw.slice(0, firstLineEnd);
  const query = firstLine.indexOf('?');
  const { head, separator, body } = splitMessage(raw);
  if (start !== undefined) {
    if (start < firstLine.length) return query >= 0 && start > query;
    return Boolean(separator) && start >= head.length + separator.length && isFormBody(raw);
  }
  if (query >= 0 && firstLine.slice(query).includes(value)) return true;
  return isFormBody(raw) && body.includes(value);
}

/** An offset in the textarea, where every line break is one "\n", as an
 * offset in the stored request, which keeps captured "\r\n". */
function rawOffset(raw: string, domOffset: number): number {
  let dom = 0;
  let index = 0;
  while (index < raw.length && dom < domOffset) {
    index += raw[index] === '\r' && raw[index + 1] === '\n' ? 2 : 1;
    dom += 1;
  }
  return index;
}

/** Replace a textarea selection in the stored request text.
 *
 * Null when the text there is no longer what was selected: the request
 * was edited after the selection was made, and replacing by offset would
 * overwrite something else.
 */
export function replaceSelection(
  raw: string,
  selection: { text: string; start: number; end: number },
  value: string,
): { text: string; end: number } | null {
  const start = rawOffset(raw, selection.start);
  const end = rawOffset(raw, selection.end);
  if (raw.slice(start, end).replace(/\r\n/g, '\n') !== selection.text) return null;
  return {
    text: raw.slice(0, start) + value + raw.slice(end),
    end: selection.start + value.replace(/\r\n/g, '\n').length,
  };
}

const STORAGE_KEY = 'lanius.inspector.charsets';

function loadChoices(): Record<string, string> {
  try {
    const parsed = JSON.parse(window.localStorage?.getItem(STORAGE_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
}

/** The charset the user last picked for this host, if any. */
export function rememberedCharset(host: string | null): string {
  if (!host) return '';
  return loadChoices()[host] ?? '';
}

/** Remember a manual charset choice for the host, or forget it. */
export function rememberCharset(host: string | null, charset: string | null): void {
  if (!host) return;
  const choices = loadChoices();
  if (charset) choices[host] = charset;
  else delete choices[host];
  try {
    window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(choices));
  } catch {
    // Storage full or unavailable: the choice applies to this session only.
  }
}

/** The OS language rather than the UI language: an English UI on a Korean
 * machine still mostly visits Korean sites. */
export function systemLocale(): string {
  if (typeof navigator === 'undefined') return '';
  return navigator.languages?.[0] ?? navigator.language ?? '';
}

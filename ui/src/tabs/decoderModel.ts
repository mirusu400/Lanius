/** Decoder tabs: several payloads, each with its own chain.
 *
 * Burp's decoder holds one payload at a time, so comparing two tokens
 * means losing the first. These tabs keep input and chain together, the
 * way Repeater keeps requests.
 */

import type { ChainStep } from '../api/client';

export interface DecoderTabState {
  id: string;
  title: string;
  input: string;
  steps: ChainStep[];
  /** Untitled tabs follow their input until the user renames them. */
  renamed: boolean;
}

let counter = 0;

export function nextDecoderId(): string {
  counter += 1;
  return `d${counter}`;
}

export function emptyDecoderTab(): DecoderTabState {
  return {
    id: nextDecoderId(),
    title: '',
    input: '',
    steps: [],
    renamed: false,
  };
}

/** A short label for a tab, derived from its input when unnamed. */
export function decoderTabTitle(tab: DecoderTabState, fallback: string): string {
  if (tab.renamed && tab.title.trim()) return tab.title.trim();
  const firstLine = tab.input.split('\n', 1)[0].trim();
  if (!firstLine) return fallback;
  return firstLine.length > 18 ? `${firstLine.slice(0, 18)}...` : firstLine;
}

/** Does this byte string look like text, or should it be shown as hex?
 *
 * Decoding often lands on binary (a gzip blob, a raw digest). Printing
 * that verbatim floods the pane with control characters, so the caller
 * offers a hex view instead.
 */
export function looksBinary(value: string): boolean {
  if (!value) return false;
  let suspicious = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    // Tab, newline and carriage return are ordinary in text.
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 32 || code === 127 || code === 0xfffd) suspicious += 1;
  }
  return suspicious / value.length > 0.1;
}

/** A hex + ASCII dump, the way a hex editor shows it. */
export function toHexDump(value: string, width = 16): string {
  const bytes = Array.from(new TextEncoder().encode(value));
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += width) {
    const slice = bytes.slice(offset, offset + width);
    const hex = slice
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ')
      .padEnd(width * 3 - 1, ' ');
    const ascii = slice
      .map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.'))
      .join('');
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex}  ${ascii}`);
  }
  return lines.join('\n');
}

/** Test helper: makes generated ids predictable. */
export function resetDecoderIds(): void {
  counter = 0;
}

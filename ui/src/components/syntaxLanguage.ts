import { isFormattable } from './bodyFormat';

export type SyntaxLanguage = 'css' | 'javascript' | 'json' | 'xml';
export type SyntaxHeaders = [string, string][] | null;

// Highlight.js tokenises synchronously. Large captures stay fully readable
// and selectable, but skip the expensive colouring pass.
export const HIGHLIGHT_LIMIT = 128 * 1024;

export function bodyLanguage(
  headers: SyntaxHeaders,
  body: string,
  fallbackMime?: string | null,
  responsePath?: string | null,
): SyntaxLanguage | null {
  const contentType = headers?.find(([name]) => name.toLowerCase() === 'content-type')?.[1];
  const mime = (contentType ?? fallbackMime ?? '').split(';', 1)[0].trim().toLowerCase();

  if (mime === 'text/html' || mime === 'application/xhtml+xml' ||
      mime === 'image/svg+xml' || mime === 'text/xml' ||
      mime === 'application/xml' || mime.endsWith('+xml')) return 'xml';
  if (mime === 'text/css') return 'css';
  if (mime === 'application/json' || mime === 'text/json' || mime.endsWith('+json')) return 'json';
  if (/^(?:application|text)\/(?:x-)?(?:java|ecma)script$/.test(mime)) return 'javascript';

  // Some servers label source files as text/plain. Use a file extension or
  // clear opening syntax only when the declared type is uninformative.
  if (mime && mime !== 'text/plain' && mime !== 'application/octet-stream') return null;
  const path = responsePath?.split(/[?#]/, 1)[0].toLowerCase() ?? '';
  if (/\.(?:js|mjs|cjs)$/.test(path)) return 'javascript';
  if (/\.css$/.test(path)) return 'css';
  if (/\.(?:html?|xhtml|svg|xml)$/.test(path)) return 'xml';
  if (/\.json$/.test(path)) return 'json';

  if (/^\s*(?:<!doctype\s+html\b|<html\b|<svg\b|<\?xml\b)/i.test(body.slice(0, 256))) return 'xml';
  if (body.length <= HIGHLIGHT_LIMIT && isFormattable(body)) return 'json';
  return null;
}

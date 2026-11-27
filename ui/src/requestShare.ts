/** A request packed into one line of text, for passing it to someone else.
 *
 * The line is a prefix naming the format and its version, followed by
 * base64url-encoded JSON. The prefix lets an import reject whatever else
 * happens to be on the clipboard, and the version lets the contents grow
 * without breaking lines that were shared earlier.
 *
 * The target URL and HTTP mode travel with the raw text: the text alone
 * does not say whether the request goes over HTTPS or to which port.
 * Responses and send history are left out; the receiver sends it again.
 */

import type { HttpMode } from './api/types';

export const SHARED_REQUEST_PREFIX = 'lanius:replay:v1:';

/** Generous for a request body, small enough to decode without stalling. */
const MAX_SHARED_LENGTH = 32 * 1024 * 1024;
const MAX_TITLE_LENGTH = 200;
const HTTP_MODES: readonly HttpMode[] = ['auto', 'http1.0', 'http1.1', 'http2'];

export interface SharedRequest {
  url: string;
  text: string;
  httpMode: HttpMode | null;
  title?: string;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  // Chunked so a large body does not overflow the argument list.
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const standard = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(standard + '='.repeat((4 - (standard.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function encodeSharedRequest(request: SharedRequest): string {
  const payload: Record<string, unknown> = { url: request.url, text: request.text };
  if (request.httpMode) payload.httpMode = request.httpMode;
  if (request.title) payload.title = request.title;
  return SHARED_REQUEST_PREFIX + toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
}

/** The request in a shared line, or null when the text is not one.
 *
 * Clipboard contents come from anywhere, so every field is checked rather
 * than trusted. Whitespace is ignored because chat apps wrap long lines.
 */
export function decodeSharedRequest(input: string): SharedRequest | null {
  if (input.length > MAX_SHARED_LENGTH) return null;
  const trimmed = input.trim();
  if (!trimmed.toLowerCase().startsWith(SHARED_REQUEST_PREFIX)) return null;
  const encoded = trimmed.slice(SHARED_REQUEST_PREFIX.length).replace(/\s+/g, '');
  if (!encoded || !/^[A-Za-z0-9\-_+/]+=*$/.test(encoded)) return null;

  let parsed: unknown;
  try {
    const json = new TextDecoder('utf-8', { fatal: true }).decode(fromBase64Url(encoded));
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const { url, text, httpMode, title } = parsed as Record<string, unknown>;
  if (typeof url !== 'string' || !/^https?:\/\/[^\s]+$/i.test(url)) return null;
  if (typeof text !== 'string' || !text.trim()) return null;
  if (httpMode != null && !HTTP_MODES.includes(httpMode as HttpMode)) return null;
  if (title != null && typeof title !== 'string') return null;

  const request: SharedRequest = { url, text, httpMode: (httpMode as HttpMode | undefined) ?? null };
  const cleanTitle = typeof title === 'string' ? title.trim().slice(0, MAX_TITLE_LENGTH) : '';
  if (cleanTitle) request.title = cleanTitle;
  return request;
}

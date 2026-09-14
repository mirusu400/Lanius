/** Repeater state: raw HTTP request text <-> engine send payload. */

import type { FlowDetail, FlowSummary } from '../api/types';
import { ParseError } from '../i18n/ParseError';
import type { Message } from '../i18n/message';

export interface RepeaterResponse {
  id: string;
  status_code: number | null;
  reason: string | null;
  headers: [string, string][];
  body: string;
  size: number;
  duration_ms: number | null;
  error: string | null;
}

export interface RepeaterTab {
  id: string;
  title: string;
  url: string;
  text: string;
  response: RepeaterResponse | null;
  sending: boolean;
  // A message rather than a sentence: these tabs are saved to the project
  // and restored later, possibly in another language.
  error: Message | null;
}

export interface SendPayload {
  url: string;
  method: string;
  headers: [string, string][];
  body: string;
}

const CRLF = '\r\n';

let counter = 0;
export function nextTabId(): string {
  counter += 1;
  return `rt-${counter}`;
}

/** Origin (scheme://host[:port]) that a tab's requests are sent to. */
export function originOf(flow: FlowSummary): string {
  const isDefaultPort =
    (flow.scheme === 'https' && flow.port === 443) ||
    (flow.scheme === 'http' && flow.port === 80);
  return `${flow.scheme}://${flow.host}${isDefaultPort ? '' : `:${flow.port}`}`;
}

/** Build a Repeater tab from a history flow (Send to Repeater). */
export function tabFromFlow(
  flow: FlowSummary,
  detail?: FlowDetail | null,
): RepeaterTab {
  const target = `${flow.path ?? '/'}${flow.query ? `?${flow.query}` : ''}`;
  const headers = detail?.request_headers ?? [['Host', flow.host ?? '']];
  const headerText = headers.map(([k, v]) => `${k}: ${v}`).join(CRLF);
  const body = detail?.request_body ?? '';
  return {
    id: nextTabId(),
    title: `${flow.method} ${flow.path ?? '/'}`,
    url: originOf(flow),
    text: `${flow.method} ${target} ${flow.http_version ?? 'HTTP/1.1'}${CRLF}${headerText}${CRLF}${CRLF}${body}`,
    response: null,
    sending: false,
    error: null,
  };
}

export function emptyTab(): RepeaterTab {
  return {
    id: nextTabId(),
    title: 'New request',
    url: 'http://example.com',
    text: `GET / HTTP/1.1${CRLF}Host: example.com${CRLF}${CRLF}`,
    response: null,
    sending: false,
    error: null,
  };
}

/** Turn the raw editor text plus the tab origin into a send payload. */
export function toSendPayload(url: string, text: string): SendPayload {
  const normalized = text.replace(/\r\n/g, '\n');
  const separator = normalized.indexOf('\n\n');
  const head = (separator === -1 ? normalized : normalized.slice(0, separator))
    .split('\n')
    .filter((line) => line.length > 0);
  const body = separator === -1 ? '' : normalized.slice(separator + 2);
  if (head.length === 0) throw new ParseError('parse.emptyRequest');

  const [method, target] = head[0].split(/\s+/);
  if (!method || !target) throw new ParseError('parse.badRequestLine');

  const headers: [string, string][] = [];
  for (const line of head.slice(1)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    headers.push([line.slice(0, idx).trim(), line.slice(idx + 1).trim()]);
  }

  const base = url.replace(/\/+$/, '');
  const absolute = /^https?:\/\//i.test(target)
    ? target
    : `${base}${target.startsWith('/') ? '' : '/'}${target}`;

  return { url: absolute, method, headers, body };
}

/** Render an engine response as raw HTTP text for display. */
export function renderResponseText(response: RepeaterResponse): string {
  if (response.error && response.status_code === null) {
    return `[error] ${response.error}`;
  }
  const status = `HTTP ${response.status_code ?? ''} ${
    response.reason ?? ''
  }`.trimEnd();
  const headers = response.headers.map(([k, v]) => `${k}: ${v}`).join('\n');
  return `${status}\n${headers}\n\n${response.body}`;
}

/** Repeater state: raw HTTP request text <-> engine send payload. */

import { rawRequest } from '../components/rawHttp';
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
  content_encoding?: string | null;
  body_decoded?: boolean;
  decode_error?: string | null;
  /** Original length, when the body was too large to keep in full. */
  truncated?: number;
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

/** A tab id that stays unique across restarts.
 *
 * A plain counter restarts at 1 with the process, so tabs restored from a
 * saved project collided with newly created ones. Two tabs sharing an id
 * meant clicking the later one activated the earlier, which looked like
 * tab switching being broken, and gave React duplicate keys as well.
 */
export function nextTabId(): string {
  counter += 1;
  const unique =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `rt-${counter}-${unique}`;
}

/** Give restored tabs fresh ids when a saved project carries collisions.
 *
 * Existing projects were saved with colliding ids, so they have to be
 * repaired on load rather than only prevented from here on.
 */
export function withUniqueIds(tabs: RepeaterTab[]): RepeaterTab[] {
  const seen = new Set<string>();
  return tabs.map((tab) => {
    if (tab.id && !seen.has(tab.id)) {
      seen.add(tab.id);
      return tab;
    }
    const id = nextTabId();
    seen.add(id);
    return { ...tab, id };
  });
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
  return {
    id: nextTabId(),
    title: `${flow.method} ${flow.path ?? '/'}`,
    url: originOf(flow),
    // Exactly the bytes that were captured. Laying the body out is a
    // way of looking at it, never a change to it: indentation inserted
    // here would go on the wire, and a request whose bytes differ from
    // the ones captured is a different request. Anything checking a
    // signature, a length or a hash would see a different body.
    text: rawRequest(flow, detail),
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
/** How much of a response body to put on screen at once.
 *
 * A binary response can be hundreds of kilobytes, and laying that out as
 * text costs hundreds of milliseconds every time the tab is shown. Past
 * this there is nothing to read anyway: it is an image or an archive.
 */
export const BODY_DISPLAY_LIMIT = 64 * 1024;

/** How much of a response body to keep in the tab.
 *
 * Tabs are autosaved into the project, so an unbounded body means the
 * saved file grows without limit and every keystroke re-serialises it.
 * Generous enough for any text response worth reading.
 */
export const BODY_KEEP_LIMIT = 256 * 1024;

/** Trim a response before it is stored, noting what was dropped. */
export function trimResponse(response: RepeaterResponse): RepeaterResponse {
  const body = response.body ?? '';
  if (body.length <= BODY_KEEP_LIMIT) return response;
  return {
    ...response,
    body: body.slice(0, BODY_KEEP_LIMIT),
    truncated: body.length,
  };
}

export function renderResponseText(
  response: RepeaterResponse,
  note: (hidden: number) => string = (n) => `[${n} more characters not shown]`,
): string {
  if (response.error && response.status_code === null) {
    return `[error] ${response.error}`;
  }
  const status = `HTTP ${response.status_code ?? ''} ${
    response.reason ?? ''
  }`.trimEnd();
  const headers = response.headers.map(([k, v]) => `${k}: ${v}`).join('\n');
  const body = response.body ?? '';
  if (body.length <= BODY_DISPLAY_LIMIT) {
    return `${status}\n${headers}\n\n${body}`;
  }
  // Truncated for display only: the full body is still in the tab, and
  // still what gets saved and sent.
  const shown = body.slice(0, BODY_DISPLAY_LIMIT);
  const hidden = body.length - BODY_DISPLAY_LIMIT;
  return `${status}\n${headers}\n\n${shown}\n\n${note(hidden)}`;
}

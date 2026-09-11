/** Raw HTTP text <-> structured edits, so the editor feels like Burp. */

import type { FlowEdits, PausedFlow } from '../api/types';
import { ParseError } from '../i18n/ParseError';

export interface ParsedRequest {
  method: string;
  path: string;
  httpVersion: string;
  headers: [string, string][];
  body: string;
}

export interface ParsedResponse {
  httpVersion: string;
  statusCode: number;
  reason: string;
  headers: [string, string][];
  body: string;
}

const CRLF = '\r\n';

function renderHeaders(headers: [string, string][]): string {
  return headers.map(([k, v]) => `${k}: ${v}`).join(CRLF);
}

function splitMessage(text: string): { head: string[]; body: string } {
  const normalized = text.replace(/\r\n/g, '\n');
  const separator = normalized.indexOf('\n\n');
  const headPart =
    separator === -1 ? normalized : normalized.slice(0, separator);
  const body = separator === -1 ? '' : normalized.slice(separator + 2);
  return { head: headPart.split('\n').filter((l) => l.length > 0), body };
}

function parseHeaderLines(lines: string[]): [string, string][] {
  const headers: [string, string][] = [];
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    headers.push([line.slice(0, idx).trim(), line.slice(idx + 1).trim()]);
  }
  return headers;
}

/** Render a paused flow's request as an editable raw HTTP message. */
export function renderRequest(flow: PausedFlow): string {
  const start = `${flow.method} ${flow.path} ${flow.http_version}`;
  const headers = renderHeaders(flow.request_headers);
  return `${start}${CRLF}${headers}${CRLF}${CRLF}${flow.request_body}`;
}

/** Render a paused flow's response as an editable raw HTTP message. */
export function renderResponse(flow: PausedFlow): string {
  const start = `${flow.http_version} ${flow.status_code ?? ''} ${
    flow.reason ?? ''
  }`.trimEnd();
  const headers = renderHeaders(flow.response_headers ?? []);
  return `${start}${CRLF}${headers}${CRLF}${CRLF}${flow.response_body ?? ''}`;
}

export function parseRequest(text: string): ParsedRequest {
  const { head, body } = splitMessage(text);
  if (head.length === 0) throw new ParseError('parse.emptyRequest');
  const [method, path, httpVersion = 'HTTP/1.1'] = head[0].split(/\s+/);
  if (!method || !path) throw new ParseError('parse.badRequestLine');
  return {
    method,
    path,
    httpVersion,
    headers: parseHeaderLines(head.slice(1)),
    body,
  };
}

export function parseResponse(text: string): ParsedResponse {
  const { head, body } = splitMessage(text);
  if (head.length === 0) throw new ParseError('parse.emptyResponse');
  const [httpVersion, status, ...reason] = head[0].split(/\s+/);
  const statusCode = Number(status);
  if (!Number.isFinite(statusCode)) {
    throw new ParseError('parse.badStatusLine');
  }
  return {
    httpVersion,
    statusCode,
    reason: reason.join(' '),
    headers: parseHeaderLines(head.slice(1)),
    body,
  };
}

/** Build the edit payload the engine expects from raw editor text. */
export function editsFromText(
  phase: 'request' | 'response',
  text: string,
): FlowEdits {
  if (phase === 'request') {
    const parsed = parseRequest(text);
    return {
      method: parsed.method,
      path: parsed.path,
      request_headers: parsed.headers,
      request_body: parsed.body,
    };
  }
  const parsed = parseResponse(text);
  return {
    status_code: parsed.statusCode,
    response_headers: parsed.headers,
    response_body: parsed.body,
  };
}

export function renderPaused(flow: PausedFlow): string {
  return flow.phase === 'request' ? renderRequest(flow) : renderResponse(flow);
}

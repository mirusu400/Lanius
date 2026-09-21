/** Rebuild the raw HTTP text of a captured exchange.
 *
 * The store keeps a request in parts, so "raw" has to be put back
 * together. Shared with Repeater, which needs the same text to make an
 * editable request out of a flow.
 */

import type { FlowDetail, FlowSummary, RequestVariant } from '../api/types';

export const CRLF = '\r\n';

/** The path and query, as they appeared on the request line. */
export function requestTarget(flow: FlowSummary): string {
  return `${flow.path ?? '/'}${flow.query ? `?${flow.query}` : ''}`;
}

/** The request as it went over the wire. */
export function rawRequest(
  flow: FlowSummary,
  detail: FlowDetail | null | undefined,
): string {
  const version = flow.http_version ?? detail?.http_version ?? 'HTTP/1.1';
  const line = `${flow.method ?? 'GET'} ${requestTarget(flow)} ${version}`;
  // Fall back to a Host header: without one the text is not a request
  // any server would accept, which matters because this is the text
  // Repeater edits and sends.
  const headers = detail?.request_headers ?? [['Host', flow.host ?? '']];
  return join(line, headers, detail?.request_body ?? '');
}

export function rawRequestVariant(variant: RequestVariant): string {
  const line = `${variant.method || 'GET'} ${variant.path || '/'} ${variant.http_version || 'HTTP/1.1'}`;
  const headers = variant.headers.length
    ? variant.headers
    : [['Host', variant.host]] as [string, string][];
  return join(line, headers, variant.body);
}

/** The response as it came back. */
export function rawResponse(
  flow: FlowSummary,
  detail: FlowDetail | null | undefined,
): string {
  if (flow.status_code == null && !detail?.response_headers?.length) return '';
  const version = flow.http_version ?? detail?.http_version ?? 'HTTP/1.1';
  // The reason phrase is optional in HTTP and often absent over HTTP/2,
  // so it is left off rather than invented.
  const reason = detail?.reason ? ` ${detail.reason}` : '';
  const line = `${version} ${flow.status_code ?? ''}${reason}`.trim();
  return join(line, detail?.response_headers ?? [], detail?.response_body ?? '');
}

function join(
  startLine: string,
  headers: [string, string][] | string[][],
  body: string,
): string {
  const headerText = headers.map(([k, v]) => `${k}: ${v}`).join(CRLF);
  const head = headerText ? `${startLine}${CRLF}${headerText}` : startLine;
  return `${head}${CRLF}${CRLF}${body}`;
}

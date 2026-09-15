/** Rebuilding the raw text of a captured exchange. */
import { describe, expect, it } from 'vitest';

import { rawRequest, rawResponse } from './rawHttp';
import type { FlowDetail, FlowSummary } from '../api/types';

const flow = {
  method: 'POST',
  host: 'api.test',
  path: '/login',
  query: 'next=%2Fhome',
  http_version: 'HTTP/1.1',
  status_code: 201,
} as FlowSummary;

const detail = {
  request_headers: [
    ['Host', 'api.test'],
    ['Content-Type', 'application/json'],
  ],
  request_body: '{"a":1}',
  response_headers: [['Content-Type', 'text/plain']],
  response_body: 'created',
  reason: 'Created',
} as unknown as FlowDetail;

describe('rawRequest', () => {
  it('starts with the request line, including the query', () => {
    expect(rawRequest(flow, detail).split('\r\n')[0]).toBe(
      'POST /login?next=%2Fhome HTTP/1.1',
    );
  });

  it('separates headers from the body with a blank line', () => {
    // Without it the body is read as another header and the text is not
    // a request any server would accept.
    const raw = rawRequest(flow, detail);
    expect(raw).toContain('Content-Type: application/json\r\n\r\n{"a":1}');
  });

  it('still produces a valid request when the detail has not loaded', () => {
    const raw = rawRequest(flow, null);
    expect(raw).toContain('POST /login?next=%2Fhome HTTP/1.1');
    expect(raw).toContain('Host: api.test');
  });

  it('defaults the path to / rather than leaving it blank', () => {
    const bare = { ...flow, path: null, query: null } as FlowSummary;
    const raw = rawRequest(bare, null);
    expect(raw.startsWith('POST / HTTP/1.1')).toBe(true);
  });
});

describe('rawResponse', () => {
  it('starts with the status line', () => {
    expect(rawResponse(flow, detail).split('\r\n')[0]).toBe(
      'HTTP/1.1 201 Created',
    );
  });

  it('leaves out a reason phrase it does not have', () => {
    // HTTP/2 has no reason phrase; inventing one would misrepresent the
    // response.
    const raw = rawResponse(flow, { ...detail, reason: null } as FlowDetail);
    expect(raw.split('\r\n')[0]).toBe('HTTP/1.1 201');
  });

  it('includes the body', () => {
    expect(rawResponse(flow, detail)).toContain('\r\n\r\ncreated');
  });

  it('is empty when there was no response', () => {
    // A request that never completed should show nothing, not a status
    // line with a blank code.
    const pending = { ...flow, status_code: null } as FlowSummary;
    expect(rawResponse(pending, null)).toBe('');
  });
});

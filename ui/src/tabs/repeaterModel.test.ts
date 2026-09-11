import { describe, expect, it } from 'vitest';

import type { FlowDetail, FlowSummary } from '../api/types';
import {
  emptyTab,
  originOf,
  renderResponseText,
  tabFromFlow,
  toSendPayload,
  type RepeaterResponse,
} from './repeaterModel';

function flow(overrides: Partial<FlowSummary> = {}): FlowSummary {
  return {
    id: 'f1',
    type: 'http',
    client_addr: null,
    server_addr: null,
    scheme: 'https',
    method: 'POST',
    host: 'api.test',
    port: 443,
    path: '/v1/login',
    query: 'next=/home',
    http_version: 'HTTP/1.1',
    request_size: 0,
    started_at: 1,
    status_code: 200,
    reason: 'OK',
    response_size: 0,
    response_mime: null,
    completed_at: null,
    duration_ms: null,
    error: null,
    source: 'proxy',
    comment: null,
    ...overrides,
  };
}

describe('originOf', () => {
  it('omits default ports', () => {
    expect(originOf(flow())).toBe('https://api.test');
    expect(originOf(flow({ scheme: 'http', port: 80 }))).toBe(
      'http://api.test',
    );
  });

  it('keeps non-default ports', () => {
    expect(originOf(flow({ port: 8443 }))).toBe('https://api.test:8443');
  });
});

describe('tabFromFlow', () => {
  it('builds a raw request from a flow and its detail', () => {
    const detail = {
      ...flow(),
      request_headers: [
        ['Host', 'api.test'],
        ['Content-Type', 'application/json'],
      ],
      request_body: '{"u":"a"}',
      response_headers: null,
      response_body: null,
    } as unknown as FlowDetail;

    const tab = tabFromFlow(flow(), detail);
    expect(tab.url).toBe('https://api.test');
    expect(tab.text).toContain('POST /v1/login?next=/home HTTP/1.1');
    expect(tab.text).toContain('Content-Type: application/json');
    expect(tab.text.endsWith('{"u":"a"}')).toBe(true);
    expect(tab.title).toBe('POST /v1/login');
  });

  it('falls back to a Host header without detail', () => {
    const tab = tabFromFlow(flow());
    expect(tab.text).toContain('Host: api.test');
  });

  it('gives each tab a unique id', () => {
    expect(tabFromFlow(flow()).id).not.toBe(tabFromFlow(flow()).id);
  });
});

describe('toSendPayload', () => {
  it('resolves a relative target against the tab origin', () => {
    const payload = toSendPayload(
      'http://127.0.0.1:9000',
      'GET /a?b=1 HTTP/1.1\nHost: h\n\n',
    );
    expect(payload.url).toBe('http://127.0.0.1:9000/a?b=1');
    expect(payload.method).toBe('GET');
    expect(payload.headers).toEqual([['Host', 'h']]);
    expect(payload.body).toBe('');
  });

  it('keeps absolute request targets', () => {
    const payload = toSendPayload(
      'http://ignored',
      'GET http://other.io/x HTTP/1.1\n\n',
    );
    expect(payload.url).toBe('http://other.io/x');
  });

  it('handles a trailing slash on the origin', () => {
    expect(
      toSendPayload('http://h:1/', 'GET /a HTTP/1.1\n\n').url,
    ).toBe('http://h:1/a');
  });

  it('extracts the body', () => {
    const payload = toSendPayload(
      'http://h',
      'POST /p HTTP/1.1\nHost: h\n\nuser=1&pw=2',
    );
    expect(payload.body).toBe('user=1&pw=2');
  });

  it('rejects malformed requests', () => {
    expect(() => toSendPayload('http://h', '')).toThrow();
    expect(() => toSendPayload('http://h', 'GET\n\n')).toThrow();
  });
});

describe('renderResponseText', () => {
  const base: RepeaterResponse = {
    id: 'r1',
    status_code: 200,
    reason: 'OK',
    headers: [['Content-Type', 'text/plain']],
    body: 'hi',
    size: 2,
    duration_ms: 12,
    error: null,
  };

  it('renders status, headers and body', () => {
    expect(renderResponseText(base)).toBe(
      'HTTP 200 OK\nContent-Type: text/plain\n\nhi',
    );
  });

  it('renders transport errors', () => {
    expect(
      renderResponseText({ ...base, status_code: null, error: 'refused' }),
    ).toBe('[error] refused');
  });
});

describe('emptyTab', () => {
  it('starts from a minimal valid request', () => {
    const tab = emptyTab();
    const payload = toSendPayload(tab.url, tab.text);
    expect(payload.method).toBe('GET');
    expect(payload.url).toBe('http://example.com/');
  });
});

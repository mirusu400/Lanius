import { describe, expect, it } from 'vitest';

import type { FlowDetail, FlowSummary } from '../api/types';
import {
  BODY_DISPLAY_LIMIT,
  BODY_KEEP_LIMIT,
  emptyTab,
  originOf,
  renderResponseText,
  tabFromFlow,
  toSendPayload,
  trimResponse,
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
    // Laid out, because a captured JSON body arrives as one line and
    // this is a text editor.
    expect(tab.text).toContain('"u": "a"');
    expect(tab.title).toBe('POST /v1/login');
  });

  it('lays out a JSON body but leaves the headers alone', () => {
    // Rewriting the whole message would reindent headers, which are not
    // JSON and are often the thing being tested.
    const detail = {
      ...flow(),
      request_headers: [
        ['Host', 'api.test'],
        ['Content-Type', 'application/json'],
      ],
      request_body: '{"a":1,"b":2}',
      response_headers: null,
      response_body: null,
    } as unknown as FlowDetail;

    const tab = tabFromFlow(flow(), detail);
    expect(tab.text).toContain('Host: api.test\r\nContent-Type');
    expect(tab.text).toContain('"a": 1');
  });

  it('leaves a body that is not JSON exactly as it was', () => {
    const detail = {
      ...flow(),
      request_headers: [['Content-Type', 'application/x-www-form-urlencoded']],
      request_body: 'user=alice&password=hunter2',
      response_headers: null,
      response_body: null,
    } as unknown as FlowDetail;

    expect(tabFromFlow(flow(), detail).text).toContain(
      'user=alice&password=hunter2',
    );
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


describe('large responses', () => {
  const base = {
    id: 'r1',
    status_code: 200,
    reason: 'OK',
    headers: [['Content-Type', 'image/png']] as [string, string][],
    size: 0,
    duration_ms: 1,
    error: null,
  };

  it('does not lay out a whole binary body as text', () => {
    // A 160KB response took 434ms to show every time the tab was opened,
    // and there is nothing to read in it: it is a PNG.
    const body = 'x'.repeat(200_000);
    const text = renderResponseText({ ...base, body });
    expect(text.length).toBeLessThan(BODY_DISPLAY_LIMIT + 500);
    // And says what it did, rather than looking like a short response.
    expect(text).toContain(String(200_000 - BODY_DISPLAY_LIMIT));
  });

  it('shows a normal response in full', () => {
    const body = 'hello';
    expect(renderResponseText({ ...base, body })).toContain('hello');
    expect(renderResponseText({ ...base, body })).not.toContain('not shown');
  });

  it('caps what is kept, since tabs are saved into the project', () => {
    const response = { ...base, body: 'y'.repeat(400_000) };
    const trimmed = trimResponse(response);
    expect(trimmed.body.length).toBe(BODY_KEEP_LIMIT);
    // The original length is recorded, so nothing pretends to be complete.
    expect(trimmed.truncated).toBe(400_000);
    // A response that fits is untouched, not copied.
    const small = { ...base, body: 'ok' };
    expect(trimResponse(small)).toBe(small);
  });
});

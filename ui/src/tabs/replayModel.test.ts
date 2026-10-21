import { describe, expect, it } from 'vitest';

import type { FlowDetail, FlowSummary } from '../api/types';
import {
  BODY_DISPLAY_LIMIT,
  BODY_KEEP_LIMIT,
  AUTO_FOLLOW_REDIRECTS_STORAGE_KEY,
  emptyTab,
  loadAutoFollowRedirects,
  originOf,
  redirectRequest,
  renderResponseText,
  saveAutoFollowRedirects,
  tabFromFlow,
  toSendPayload,
  trimResponse,
  type ReplayResponse,
} from './replayModel';

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

function redirectResponse(status: number, location: string): ReplayResponse {
  return {
    id: `redirect-${status}`,
    status_code: status,
    reason: 'Redirect',
    headers: [['Location', location]],
    body: '',
    size: 0,
    duration_ms: 1,
    error: null,
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

  it('carries the captured bytes, not a reformatted copy of them', () => {
    // Indentation inserted here would go on the wire. Anything checking
    // a signature, a length or a hash would see a different body, so a
    // request that cannot be reproduced is worse than an ugly one.
    const body = '{"a":1,"b":2}';
    const detail = {
      ...flow(),
      request_headers: [
        ['Host', 'api.test'],
        ['Content-Type', 'application/json'],
      ],
      request_body: body,
      response_headers: null,
      response_body: null,
    } as unknown as FlowDetail;

    const tab = tabFromFlow(flow(), detail);
    expect(tab.text.endsWith(body)).toBe(true);
    // The giveaway: formatting adds a space after the colon.
    expect(tab.text).not.toContain('"a": 1');
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

describe('redirectRequest', () => {
  it('resolves a relative 302 and changes POST to GET', () => {
    const next = redirectRequest({
      url: 'https://app.test',
      text: [
        'POST /login HTTP/1.1',
        'Host: app.test',
        'Cookie: session=one',
        'Content-Type: application/json',
        'Content-Length: 7',
        '',
        '{"a":1}',
      ].join('\r\n'),
    }, redirectResponse(302, '../home?from=login#section'));

    expect(next).not.toBeNull();
    expect(next?.url).toBe('https://app.test');
    expect(next?.destination).toBe('https://app.test/home?from=login');
    expect(next?.text).toContain('GET /home?from=login HTTP/1.1');
    expect(next?.text).toContain('Cookie: session=one');
    expect(next?.text).not.toContain('Content-Type');
    expect(next?.text).not.toContain('{"a":1}');
  });

  it('preserves a 307 body but strips credentials across origins', () => {
    const next = redirectRequest({
      url: 'https://app.test',
      text: [
        'PUT /upload HTTP/1.1',
        'Host: app.test',
        'Authorization: Bearer secret',
        'Proxy-Authorization: Basic secret',
        'Cookie: session=one',
        'Content-Type: text/plain',
        '',
        'payload',
      ].join('\r\n'),
    }, redirectResponse(307, 'https://storage.test:8443/next'));

    expect(next?.url).toBe('https://storage.test:8443');
    expect(next?.text).toContain('PUT /next HTTP/1.1');
    expect(next?.text).toContain('Host: storage.test:8443');
    expect(next?.text).toContain('Content-Type: text/plain');
    expect(next?.text.endsWith('payload')).toBe(true);
    expect(next?.text).not.toContain('Authorization:');
    expect(next?.text).not.toContain('Cookie:');
  });

  it('uses GET for a 303 but preserves method and body for a 308', () => {
    const source = {
      url: 'http://app.test',
      text: 'PATCH /one HTTP/1.1\r\nHost: app.test\r\nContent-Length: 4\r\n\r\ndata',
    };
    expect(redirectRequest(source, redirectResponse(303, '/two'))?.text)
      .toContain('GET /two HTTP/1.1');
    const permanent = redirectRequest(source, redirectResponse(308, '/two'));
    expect(permanent?.text).toContain('PATCH /two HTTP/1.1');
    expect(permanent?.text.endsWith('data')).toBe(true);
  });

  it('ignores non-redirect statuses and unsafe destinations', () => {
    const source = { url: 'http://app.test', text: 'GET / HTTP/1.1\r\n\r\n' };
    expect(redirectRequest(source, redirectResponse(304, '/cached'))).toBeNull();
    expect(redirectRequest(source, redirectResponse(302, 'file:///tmp/x'))).toBeNull();
    expect(redirectRequest(source, redirectResponse(302, 'http://u:p@app.test/')))
      .toBeNull();
    expect(redirectRequest(source, { ...redirectResponse(302, '/x'), headers: [] }))
      .toBeNull();
  });
});

describe('automatic redirect option', () => {
  it('defaults off and persists an explicit choice', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    expect(loadAutoFollowRedirects(storage)).toBe(false);
    saveAutoFollowRedirects(true, storage);
    expect(values.get(AUTO_FOLLOW_REDIRECTS_STORAGE_KEY)).toBe('1');
    expect(loadAutoFollowRedirects(storage)).toBe(true);
    saveAutoFollowRedirects(false, storage);
    expect(loadAutoFollowRedirects(storage)).toBe(false);
  });
});

describe('renderResponseText', () => {
  const base: ReplayResponse = {
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

describe('the bytes that go on the wire', () => {
  it('sends the body exactly as it appears in the editor', () => {
    // Formatting is a way of looking at a request, never a change to it.
    // Indentation inserted into the stored text would go on the wire,
    // and anything checking a length, a hash or a signature would see a
    // different body.
    const body = '{"user":"alice","token":"abc123"}';
    const text = `POST /x HTTP/1.1\nHost: api.test\n\n${body}`;
    expect(toSendPayload('https://api.test', text).body).toBe(body);
  });

  it('does not add whitespace to a compact JSON body', () => {
    const text = 'POST /x HTTP/1.1\nHost: a\n\n{"a":1,"b":[1,2]}';
    const sent = toSendPayload('https://a', text).body;
    expect(sent).not.toContain('"a": 1');
    expect(sent).toBe('{"a":1,"b":[1,2]}');
  });

  it('keeps a body that was deliberately laid out', () => {
    // The reverse case: if someone formats it themselves, that is the
    // request they meant to send.
    const body = '{\n  "a": 1\n}';
    const text = `POST /x HTTP/1.1\nHost: a\n\n${body}`;
    expect(toSendPayload('https://a', text).body).toBe(body);
  });

  it('preserves a body that is not JSON at all', () => {
    const body = 'user=alice&sig=9f2b';
    const text = `POST /x HTTP/1.1\nHost: a\n\n${body}`;
    expect(toSendPayload('https://a', text).body).toBe(body);
  });
});


it('carries the raw HTTP version and explicit protocol override to the engine', () => {
  const payload = toSendPayload('https://example.test', 'GET / HTTP/1.0\n\n', 'http2');
  expect(payload.http_version).toBe('HTTP/1.0');
  expect(payload.http_mode).toBe('http2');
});

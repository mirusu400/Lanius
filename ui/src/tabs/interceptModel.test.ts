import { describe, expect, it } from 'vitest';

import type { PausedFlow } from '../api/types';
import {
  editsFromText,
  parseRequest,
  parseResponse,
  renderPaused,
  renderRequest,
  renderResponse,
} from './interceptModel';

function paused(overrides: Partial<PausedFlow> = {}): PausedFlow {
  return {
    id: 'p1',
    phase: 'request',
    method: 'GET',
    scheme: 'http',
    host: 'example.com',
    port: 80,
    path: '/a?b=1',
    http_version: 'HTTP/1.1',
    request_headers: [
      ['Host', 'example.com'],
      ['Accept', '*/*'],
    ],
    request_body: '',
    ...overrides,
  };
}

describe('renderRequest', () => {
  it('renders a raw HTTP request', () => {
    expect(renderRequest(paused())).toBe(
      'GET /a?b=1 HTTP/1.1\r\nHost: example.com\r\nAccept: */*\r\n\r\n',
    );
  });

  it('includes the body', () => {
    const text = renderRequest(
      paused({ method: 'POST', request_body: '{"a":1}' }),
    );
    expect(text.endsWith('\r\n\r\n{"a":1}')).toBe(true);
  });
});

describe('renderResponse', () => {
  it('renders a raw HTTP response', () => {
    const flow = paused({
      phase: 'response',
      status_code: 404,
      reason: 'Not Found',
      response_headers: [['Content-Type', 'text/html']],
      response_body: 'nope',
    });
    expect(renderResponse(flow)).toBe(
      'HTTP/1.1 404 Not Found\r\nContent-Type: text/html\r\n\r\nnope',
    );
  });
});

describe('parseRequest', () => {
  it('round-trips a rendered request', () => {
    const parsed = parseRequest(renderRequest(paused()));
    expect(parsed.method).toBe('GET');
    expect(parsed.path).toBe('/a?b=1');
    expect(parsed.headers).toEqual([
      ['Host', 'example.com'],
      ['Accept', '*/*'],
    ]);
    expect(parsed.body).toBe('');
  });

  it('parses edits made by hand, including LF-only line endings', () => {
    const parsed = parseRequest(
      'POST /login HTTP/1.1\nHost: t.io\nX-A: 1\n\nuser=admin',
    );
    expect(parsed.method).toBe('POST');
    expect(parsed.path).toBe('/login');
    expect(parsed.headers).toEqual([
      ['Host', 't.io'],
      ['X-A', '1'],
    ]);
    expect(parsed.body).toBe('user=admin');
  });

  it('keeps colons inside header values', () => {
    const parsed = parseRequest('GET / HTTP/1.1\nReferer: http://a.io/x\n\n');
    expect(parsed.headers[0]).toEqual(['Referer', 'http://a.io/x']);
  });

  it('rejects empty or malformed requests', () => {
    expect(() => parseRequest('')).toThrow();
    expect(() => parseRequest('GET\n\n')).toThrow();
  });
});

describe('parseResponse', () => {
  it('parses status line and headers', () => {
    const parsed = parseResponse(
      'HTTP/1.1 500 Internal Server Error\nX: 1\n\nboom',
    );
    expect(parsed.statusCode).toBe(500);
    expect(parsed.reason).toBe('Internal Server Error');
    expect(parsed.body).toBe('boom');
  });

  it('rejects a non-numeric status', () => {
    expect(() => parseResponse('HTTP/1.1 abc\n\n')).toThrow();
  });
});

describe('editsFromText', () => {
  it('builds request edits', () => {
    const edits = editsFromText(
      'request',
      'PUT /new HTTP/1.1\nHost: e.com\n\nbody',
    );
    expect(edits).toEqual({
      method: 'PUT',
      path: '/new',
      request_headers: [['Host', 'e.com']],
      request_body: 'body',
    });
  });

  it('builds response edits', () => {
    const edits = editsFromText('response', 'HTTP/1.1 418 Teapot\nX: 1\n\nhi');
    expect(edits).toEqual({
      status_code: 418,
      response_headers: [['X', '1']],
      response_body: 'hi',
    });
  });
});

describe('renderPaused', () => {
  it('picks the renderer matching the phase', () => {
    expect(renderPaused(paused())).toContain('GET /a?b=1');
    expect(
      renderPaused(paused({ phase: 'response', status_code: 200 })),
    ).toContain('HTTP/1.1 200');
  });
});

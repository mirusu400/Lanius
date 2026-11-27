import { describe, expect, it } from 'vitest';

import { SHARED_REQUEST_PREFIX, decodeSharedRequest, encodeSharedRequest } from './requestShare';

const request = {
  url: 'https://api.test:8443',
  text: 'POST /한글?q=1 HTTP/1.1\r\nHost: api.test\r\n\r\n{"emoji":"🙂"}',
  httpMode: 'http2' as const,
  title: 'POST /한글',
};

describe('shared requests', () => {
  it('round-trips the target, mode, title and exact bytes of the text', () => {
    const line = encodeSharedRequest(request);
    expect(line.startsWith(SHARED_REQUEST_PREFIX)).toBe(true);
    expect(line.slice(SHARED_REQUEST_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeSharedRequest(line)).toEqual(request);
  });

  it('accepts a line wrapped or padded by a chat app', () => {
    const line = encodeSharedRequest({ ...request, httpMode: null, title: undefined });
    const wrapped = `  ${line.slice(0, 30)}\n${line.slice(30, 60)} \r\n${line.slice(60)}\n`;
    expect(decodeSharedRequest(wrapped)).toEqual({ url: request.url, text: request.text, httpMode: null });
  });

  it('rejects anything that is not a valid shared request', () => {
    const encode = (value: unknown) => SHARED_REQUEST_PREFIX + btoa(JSON.stringify(value));
    expect(decodeSharedRequest('GET / HTTP/1.1')).toBeNull();
    expect(decodeSharedRequest(SHARED_REQUEST_PREFIX)).toBeNull();
    expect(decodeSharedRequest(`${SHARED_REQUEST_PREFIX}!!!`)).toBeNull();
    expect(decodeSharedRequest(SHARED_REQUEST_PREFIX + btoa('not json'))).toBeNull();
    expect(decodeSharedRequest(encode([1]))).toBeNull();
    expect(decodeSharedRequest(encode({ url: 'file:///etc/passwd', text: 'GET / HTTP/1.1' }))).toBeNull();
    expect(decodeSharedRequest(encode({ url: 'http://a.test', text: 1 }))).toBeNull();
    expect(decodeSharedRequest(encode({ url: 'http://a.test', text: '  ' }))).toBeNull();
    expect(decodeSharedRequest(encode({ url: 'http://a.test', text: 'GET /', httpMode: 'h3' }))).toBeNull();
    expect(decodeSharedRequest(encode({ url: 'http://a.test', text: 'GET /', title: {} }))).toBeNull();
  });
});

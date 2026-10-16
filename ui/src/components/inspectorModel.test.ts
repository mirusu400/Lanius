import { afterEach, describe, expect, it } from 'vitest';

import {
  isFormValue,
  rememberCharset,
  rememberedCharset,
  replaceSelection,
  requestHost,
} from './inspectorModel';

afterEach(() => window.localStorage.clear());

describe('requestHost', () => {
  it('reads the Host header, else the absolute URL', () => {
    expect(requestHost('GET / HTTP/1.1\nHost: Shop.Example.KR\n\n')).toBe('shop.example.kr');
    expect(requestHost('GET https://a.example.jp/x HTTP/1.1\n\n')).toBe('a.example.jp');
    expect(requestHost('nonsense')).toBeNull();
  });
});

describe('isFormValue', () => {
  const query = 'GET /s?q=a+b HTTP/1.1\nHost: x\n\n';
  const form = 'POST /s HTTP/1.1\nContent-Type: application/x-www-form-urlencoded\n\nq=a+b';
  const json = 'POST /s HTTP/1.1\nContent-Type: application/json\n\n{"q":"a+b"}';

  it('treats the query string and urlencoded bodies as form-encoded', () => {
    expect(isFormValue(query, 'a+b', query.indexOf('a+b'))).toBe(true);
    expect(isFormValue(form, 'a+b', form.replace(/\r\n/g, '\n').indexOf('a+b'))).toBe(true);
  });

  it('treats paths, headers and JSON bodies as not form-encoded', () => {
    const path = 'GET /a+b?q=1 HTTP/1.1\n\n';
    expect(isFormValue(path, 'a+b', path.indexOf('a+b'))).toBe(false);
    expect(isFormValue(json, 'a+b', json.indexOf('a+b'))).toBe(false);
    expect(isFormValue(form, 'x-www', form.indexOf('x-www'))).toBe(false);
  });

  it('uses textarea offsets, where CRLF counts as one', () => {
    const crlf = 'POST /s HTTP/1.1\r\nContent-Type: application/x-www-form-urlencoded\r\n\r\nq=a+b';
    const lf = crlf.replace(/\r\n/g, '\n');
    expect(isFormValue(crlf, 'a+b', lf.indexOf('a+b'))).toBe(true);
  });

  it('falls back to where the value occurs without an offset', () => {
    expect(isFormValue(query, 'a+b')).toBe(true);
    expect(isFormValue(json, 'a+b')).toBe(false);
  });
});

describe('replaceSelection', () => {
  it('maps textarea offsets back onto CRLF text', () => {
    const raw = 'GET /?q=%C7%CF HTTP/1.1\r\nHost: x\r\n\r\nbody=%C7%CF';
    const lf = raw.replace(/\r\n/g, '\n');
    const start = lf.lastIndexOf('%C7%CF');
    const replaced = replaceSelection(raw, { text: '%C7%CF', start, end: start + 6 }, '%B3%AA');
    expect(replaced?.text).toBe('GET /?q=%C7%CF HTTP/1.1\r\nHost: x\r\n\r\nbody=%B3%AA');
    expect(replaced?.end).toBe(start + 6);
  });

  it('refuses when the text there has changed', () => {
    expect(replaceSelection('abcdef', { text: 'cd', start: 1, end: 3 }, 'XY')).toBeNull();
  });
});

describe('remembered charsets', () => {
  it('are kept per host and can be forgotten', () => {
    rememberCharset('a.example', 'cp949');
    expect(rememberedCharset('a.example')).toBe('cp949');
    expect(rememberedCharset('b.example')).toBe('');
    rememberCharset('a.example', null);
    expect(rememberedCharset('a.example')).toBe('');
    expect(rememberedCharset(null)).toBe('');
  });
});

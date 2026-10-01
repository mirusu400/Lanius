import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';

import { HighlightedBody, HighlightedMessage } from './SyntaxCode';
import { bodyLanguage } from './syntaxLanguage';

afterEach(cleanup);

it('chooses source syntax from Content-Type, including structured suffixes', () => {
  expect(bodyLanguage([['content-type', 'text/html; charset=UTF-8']], '<p>x</p>')).toBe('xml');
  expect(bodyLanguage([['Content-Type', 'application/javascript']], 'const x = 1')).toBe('javascript');
  expect(bodyLanguage([['Content-Type', 'application/problem+json']], '{}')).toBe('json');
  expect(bodyLanguage([['Content-Type', 'text/plain']], 'const x = 1', null, '/app.js?v=1')).toBe('javascript');
  expect(bodyLanguage([['Content-Type', 'image/png']], '<html>x</html>')).toBeNull();
});

it('keeps captured HTML inert while highlighting it', () => {
  const source = '<img src=x onerror="alert(1)">';
  const { container } = render(<HighlightedBody text={source} headers={[["Content-Type", "text/html"]]} />);
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('.hljs-name')?.textContent).toBe('img');
  expect(container.querySelector('pre')?.textContent).toBe(source);
});

it('preserves raw HTTP text and skips tokenising an oversized body', () => {
  const body = `const value = '${'x'.repeat(128 * 1024)}';`;
  const source = `POST / HTTP/1.1\r\nContent-Type: application/javascript\r\n\r\n${body}`;
  const { container } = render(<HighlightedMessage
    text={source}
    headers={[["Content-Type", "application/javascript"]]}
    className="raw-view"
  />);
  expect(container.querySelector('pre')?.textContent).toBe(source);
  expect(container.querySelector('.hljs-attr')?.textContent).toBe('Content-Type');
  expect(container.querySelector('.hljs-keyword')?.textContent).toBe('POST');
  expect(container.querySelectorAll('.hljs-string')).toHaveLength(0);
});

it('selects the whole highlighted message with the keyboard', () => {
  const source = 'GET / HTTP/1.1\nHost: example.test\n\n';
  const { container } = render(<HighlightedMessage text={source} headers={[]} className="raw-view" />);
  const pre = container.querySelector('pre')!;
  pre.focus();
  fireEvent.keyDown(pre, { key: 'a', metaKey: true });
  expect(window.getSelection()?.toString()).toBe(source);
  window.getSelection()?.removeAllRanges();
});

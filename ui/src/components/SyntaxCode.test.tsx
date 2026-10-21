import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderWithI18n } from '../test-utils';

import { HighlightedBody, HighlightedEditor, HighlightedMessage } from './SyntaxCode';
import { bodyLanguage } from './syntaxLanguage';

// Viewport layout/clipboard needs a real browser. This unit test checks
// that routing passes the complete source through unchanged.
vi.mock('./LargeTextView', () => ({ default: ({ text, className }: { text: string; className: string }) =>
  <div className={className} data-testid="large-text">{text}</div> }));

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

it('uses distinct syntax colours for query parameter keys and values', () => {
  const source = 'GET /search?name=alice&role=admin%20user&empty= HTTP/1.1\r\nHost: example.test\r\n\r\n';
  const { container } = render(<HighlightedMessage text={source} headers={[]} className="raw-view" />);
  const requestLine = container.querySelector('code')!;

  expect(requestLine.textContent).toBe(source);
  expect(requestLine.querySelector('.hljs-link')?.textContent).toBe('/search');
  expect([...requestLine.querySelectorAll('.hljs-attr')].map((node) => node.textContent))
    .toEqual(['name', 'role', 'empty', 'Host']);
  expect([...requestLine.querySelectorAll('.hljs-string')].map((node) => node.textContent))
    .toEqual(['alice', 'admin%20user']);
});

it('routes oversized HTTP messages to the asynchronous viewer without truncating their source', async () => {
  const body = `const value = '${'x'.repeat(128 * 1024)}';`;
  const source = `POST / HTTP/1.1\r\nContent-Type: application/javascript\r\n\r\n${body}`;
  const { container } = renderWithI18n(<HighlightedMessage
    text={source}
    headers={[["Content-Type", "application/javascript"]]}
    className="raw-view"
  />);
  expect((await screen.findByTestId('large-text')).textContent).toBe(source);
  expect(container.querySelectorAll('.hljs-string')).toHaveLength(0);
});

it.each([
  { key: 'a', metaKey: true },
  { key: 'a', ctrlKey: true },
  { key: 'ㅁ', code: 'KeyA', ctrlKey: true },
])('selects the whole highlighted message with the keyboard (%j)', (shortcut) => {
  const source = 'GET / HTTP/1.1\nHost: example.test\n\n';
  const { container } = render(<HighlightedMessage text={source} headers={[]} className="raw-view" />);
  const pre = container.querySelector('pre')!;
  pre.focus();
  fireEvent.keyDown(pre, shortcut);
  expect(window.getSelection()?.toString()).toBe(source);
  window.getSelection()?.removeAllRanges();
});

it('labels CRLF, LF and CR without changing selections or search offsets', () => {
  const source = 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nfirst\nsecond\rthird';
  const { container } = render(<HighlightedMessage text={source} headers={[]} className="raw-view"
    showLineEndings wrap={false} query="second" activeIndex={0} />);
  expect([...container.querySelectorAll('.code-line-ending')].map((node) => node.getAttribute('data-eol')))
    .toEqual(['\\r\\n', '\\r\\n', '\\r\\n', '\\n', '\\r']);
  expect(container.querySelector('.find-current')?.textContent).toBe('second');
  const pre = container.querySelector('pre')!;
  expect(pre.textContent).toBe(source);
  fireEvent.keyDown(pre, { key: 'a', ctrlKey: true });
  expect(window.getSelection()?.toString()).toBe(source);
  window.getSelection()?.removeAllRanges();
});

it('aligns editable line endings with textarea normalisation while labelling the original endings', () => {
  const source = 'POST / HTTP/1.1\r\nHost: example.test\r\n\r\nfirst\rsecond\nthird';
  const { container } = render(<HighlightedEditor text={source} headers={[]} className="replay-editor"
    showLineEndings onChange={() => { throw new Error('A display option must not edit the request'); }} />);
  const textarea = container.querySelector('textarea')!;
  expect(container.querySelector('pre')?.textContent).toBe(textarea.value);
  expect([...container.querySelectorAll('.code-line-ending')].map((node) => node.getAttribute('data-eol')))
    .toEqual(['\\r\\n', '\\r\\n', '\\r\\n', '\\r', '\\n']);
});

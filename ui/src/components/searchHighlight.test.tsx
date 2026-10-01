import { render } from '@testing-library/react';
import { expect, it } from 'vitest';

import { HighlightedMessage } from './SyntaxCode';
import { findMatches } from './searchHighlight';
import { markHtmlPreview } from './htmlPreviewSearch';

it('finds literal, case-insensitive text without treating punctuation as a pattern', () => {
  expect(findMatches('A.* a.*', 'a.*')).toEqual([{ start: 0, end: 3 }, { start: 4, end: 7 }]);
});

it('marks a raw match spanning syntax tokens without changing captured bytes', () => {
  const source = 'GET /x HTTP/1.1\r\nHost: api.test\r\n\r\n';
  const { container } = render(<HighlightedMessage text={source} headers={[]} className="raw-view" query="GET /x" activeIndex={0} />);
  const pre = container.querySelector('pre')!;
  expect(pre.textContent).toBe(source);
  expect(pre.querySelector('.hljs-keyword')?.textContent).toBe('GET');
  expect([...pre.querySelectorAll('mark[data-find-index="0"]')].map((mark) => mark.textContent).join('')).toBe('GET /x');
  expect(pre.querySelector('mark.find-current')).toBeTruthy();
});

it('keeps hostile raw HTTP content inert while marking it', () => {
  const source = 'POST / HTTP/1.1\r\nX-Test: <img src=x onerror=alert(1)>\r\n\r\n<script>alert(1)</script>';
  const { container } = render(<HighlightedMessage text={source} headers={[]} className="raw-view" query="script" activeIndex={0} />);
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('script')).toBeNull();
  expect(container.querySelector('pre')?.textContent).toBe(source);
  expect(container.querySelector('mark.find-current')?.textContent).toBe('script');
});

it('searches rendered HTML text while leaving scripts unmarked', () => {
  const result = markHtmlPreview('<script>needle</script><p>Needle <b>need</b>le</p>', 'needle', 1);
  expect(result.count).toBe(2);
  expect(result.html).toContain('<script>needle</script>');
  expect(result.html).toContain('data-find-index="1"');
  expect(result.html).not.toContain('<script><mark');
});

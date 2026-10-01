import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { renderWithI18n as render, t } from '../test-utils';
import { ResponsePreview } from './ResponsePreview';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('highlights rendered HTML text inside the restricted preview document', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ kind: 'html', text: '<p>Alpha <b>alpha</b></p><script>alpha</script>' }),
  })));
  const onMatchCount = vi.fn();
  render(<ResponsePreview flowId="html" query="alpha" activeIndex={1} onMatchCount={onMatchCount} />);
  const frame = await screen.findByTitle(t('detail.preview.htmlTitle')) as HTMLIFrameElement;
  await waitFor(() => expect(onMatchCount).toHaveBeenLastCalledWith(2));
  expect(frame.getAttribute('sandbox')).toBe('');
  expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
  const srcDoc = frame.getAttribute('srcdoc') || '';
  expect(srcDoc).toContain("script-src 'none'");
  expect(srcDoc).toContain('data-find-index="1"');
  expect(srcDoc).toContain('<script>alpha</script>');
  expect(srcDoc).not.toContain('<script><mark');
  expect(srcDoc).not.toContain('autofocus');
  expect(document.querySelector('.response-preview-find-snippet')?.textContent).toBe('Alpha alpha');
  expect(document.querySelector('.response-preview-find-snippet mark.find-current')?.textContent).toBe('alpha');
});

it('searches displayed CSV cells and reports the visible match count', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ kind: 'csv', rows: [['one', 'two'], ['ONE', 'three']] }),
  })));
  const onMatchCount = vi.fn();
  render(<ResponsePreview flowId="csv" query="one" activeIndex={1} onMatchCount={onMatchCount} />);
  await waitFor(() => expect(onMatchCount).toHaveBeenLastCalledWith(2));
  expect(document.querySelectorAll('.preview-grid mark')).toHaveLength(2);
  expect(document.querySelector('.preview-grid mark.find-current')?.textContent).toBe('ONE');
});

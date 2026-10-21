import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import { renderWithI18n as render, t } from '../test-utils';
import { ResponsePreview } from './ResponsePreview';

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
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

it('limits select-all to the displayed preview grid', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ kind: 'csv', rows: [['one', 'two'], ['three', 'four']] }),
  })));
  render(<><p>outside preview</p><ResponsePreview flowId="csv" /></>);
  const cell = await screen.findByText('three');
  await userEvent.click(cell);
  expect(document.activeElement?.className).toBe('preview-grid-scroll');
  fireEvent.keyDown(document.activeElement!, { key: 'a', ctrlKey: true });
  expect(window.getSelection()?.toString()).toBe(document.querySelector('.preview-grid')?.textContent);
  expect(window.getSelection()?.toString()).not.toContain('outside preview');
});

it('selects only the opened archive entry when its file button has focus', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ kind: 'archive', total_entries: 2, entries: [
      { name: 'first.txt', directory: false, size: 5, text: 'first' },
      { name: 'second.txt', directory: false, size: 6, text: 'second' },
    ] }),
  })));
  render(<ResponsePreview flowId="archive" />);
  const file = await screen.findByRole('option', { name: /second.txt/ });
  await userEvent.click(file);
  fireEvent.keyDown(file, { key: 'a', metaKey: true });
  expect(window.getSelection()?.toString()).toBe('second');
});

it('colours a text preview using its response MIME while keeping search marks', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ kind: 'text', text: 'const answer = 42;', mime: 'application/javascript', path: '/script.js' }),
  })));
  const onMatchCount = vi.fn();
  render(<ResponsePreview flowId="script" query="answer" activeIndex={0} onMatchCount={onMatchCount} />);
  await waitFor(() => expect(onMatchCount).toHaveBeenLastCalledWith(1));
  expect(document.querySelector('.response-preview-text .hljs-keyword')?.textContent).toBe('const');
  expect(document.querySelector('.response-preview-text mark.find-current')?.textContent).toBe('answer');
});

it('reloads the preview with the selected response charset', async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL) => ({
    ok: true,
    json: async () => ({ kind: 'html', text: '<p>日本語</p>' }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  const { rerender } = render(<ResponsePreview flowId="legacy" charset="shift_jis" />);
  await screen.findByTitle(t('detail.preview.htmlTitle'));
  expect(String(fetchMock.mock.calls[0][0])).toContain(
    '/api/flows/legacy/response-preview?charset=shift_jis',
  );

  rerender(<ResponsePreview flowId="legacy" charset="cp949" />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(String(fetchMock.mock.calls[1][0])).toContain(
    '/api/flows/legacy/response-preview?charset=cp949',
  );
});

it('shows a loading circle and aborts an old preview without displaying its late result', async () => {
  const pending = new Map<string, (value: Response) => void>();
  const signals: AbortSignal[] = [];
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.signal) signals.push(init.signal);
    return new Promise<Response>(resolve => pending.set(new URL(String(input)).pathname, resolve));
  }));
  const { rerender } = render(<ResponsePreview flowId="old" />);
  expect(screen.getByRole('status', { name: t('detail.preview.loading') })).toBeTruthy();
  rerender(<ResponsePreview flowId="new" />);
  expect(signals[0].aborted).toBe(true);
  const response = (text: string) => ({ ok: true, json: async () => ({ kind: 'text', text, mime: 'text/plain' }) }) as Response;
  pending.get('/api/flows/new/response-preview')!(response('current preview'));
  expect(await screen.findByText('current preview')).toBeTruthy();
  pending.get('/api/flows/old/response-preview')!(response('outdated preview'));
  await waitFor(() => expect(screen.queryByText('outdated preview')).toBeNull());
});

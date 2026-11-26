/** The Diagnostics section and UI error capture. */
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openUrl = vi.fn();
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: (url: string) => openUrl(url) }));

import { DiagnosticsSection } from './settings/DiagnosticsSection';
import { ErrorBoundary } from '../components/ErrorBoundary';
import type { DiagnosticReport } from '../api/client';
import { installErrorReporting, reportError, resetErrorReporting } from '../errorReporting';
import { renderWithI18n, t } from '../test-utils';

const report: DiagnosticReport = {
  id: 'abc123',
  source: 'engine',
  time: '2026-11-26T05:00:00+00:00',
  kind: 'RuntimeError',
  message: 'proxy stopped\nsecond line',
  traceback: 'Traceback (most recent call last):\n  File "~/x.py"',
  context: {},
};

type Reply = { status?: number; body: unknown };

function mockFetch(route: (url: string, init?: RequestInit) => Reply) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const { status = 200, body } = route(String(url), init);
    return {
      ok: status < 400,
      status,
      statusText: '',
      json: async () => body,
      clone() { return this; },
      blob: async () => new Blob(['zip']),
    };
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

beforeEach(() => {
  resetErrorReporting();
  openUrl.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('DiagnosticsSection', () => {
  it('says when nothing has been recorded', async () => {
    mockFetch(() => ({ body: { items: [], count: 0 } }));
    renderWithI18n(<DiagnosticsSection />);
    expect(await screen.findByText(t('diagnostics.empty'))).toBeTruthy();
  });

  it('lists recorded errors with their first line and traceback', async () => {
    mockFetch(() => ({ body: { items: [report], count: 1 } }));
    renderWithI18n(<DiagnosticsSection />);
    expect(await screen.findByText('RuntimeError: proxy stopped')).toBeTruthy();
    expect(screen.getByText(t('diagnostics.count', { count: 1 }))).toBeTruthy();
    expect(screen.getByText(/Traceback \(most recent call last\)/)).toBeTruthy();
  });

  it('opens the prefilled issue page', async () => {
    const issue = 'https://github.com/mirusu400/Lanius/issues/new?title=x';
    const fetchMock = mockFetch((url) => url.includes('/api/diagnostics/issue')
      ? { body: { url: issue } }
      : { body: { items: [report], count: 1 } });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    renderWithI18n(<DiagnosticsSection />);
    await userEvent.click(await screen.findByRole('button', { name: t('diagnostics.issue') }));
    await waitFor(() => expect(open).toHaveBeenCalledWith(issue, '_blank', 'noopener,noreferrer'));
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/issue'));
    expect(call?.[1]?.method).toBe('POST');
  });

  it('leaves a Lockdown refusal to the shared toast', async () => {
    mockFetch((url) => url.includes('/api/diagnostics/issue')
      ? { status: 423, body: { detail: 'LOCKDOWN_MODE_BLOCKED' } }
      : { body: { items: [], count: 0 } });
    const blocked = vi.fn();
    window.addEventListener('lanius:lockdown-blocked', blocked);
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    renderWithI18n(<DiagnosticsSection />);
    await userEvent.click(await screen.findByRole('button', { name: t('diagnostics.issue') }));
    await waitFor(() => expect(blocked).toHaveBeenCalled());
    window.removeEventListener('lanius:lockdown-blocked', blocked);
    expect(open).not.toHaveBeenCalled();
    expect(screen.queryByText(/Diagnostics failed|진단 정보 작업에 실패/)).toBeNull();
  });

  it('clears recorded errors', async () => {
    let items = [report];
    const fetchMock = mockFetch((_url, init) => {
      if (init?.method === 'DELETE') { items = []; return { body: { removed: 1 } }; }
      return { body: { items, count: items.length } };
    });
    renderWithI18n(<DiagnosticsSection />);
    await userEvent.click(await screen.findByRole('button', { name: t('diagnostics.clear') }));
    expect(await screen.findByText(t('diagnostics.empty'))).toBeTruthy();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true);
  });
});

describe('error reporting', () => {
  function posted(fetchMock: ReturnType<typeof mockFetch>) {
    return fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith('/api/diagnostics/reports'))
      .map(([, init]) => JSON.parse(String(init?.body)));
  }

  it('posts an error once while it keeps repeating', () => {
    const fetchMock = mockFetch(() => ({ body: { recorded: true } }));
    const error = new TypeError('x is undefined');
    expect(reportError(error, 'render')).toBe(true);
    expect(reportError(error, 'render')).toBe(false);
    expect(posted(fetchMock)).toEqual([
      expect.objectContaining({ kind: 'TypeError', message: 'x is undefined', where: 'render' }),
    ]);
  });

  it('ignores browser noise', () => {
    mockFetch(() => ({ body: {} }));
    expect(reportError(new Error('ResizeObserver loop completed with undelivered notifications.'), 'x')).toBe(false);
  });

  it('captures unhandled rejections', () => {
    const fetchMock = mockFetch(() => ({ body: {} }));
    const remove = installErrorReporting(window);
    const event = new Event('unhandledrejection') as PromiseRejectionEvent;
    Object.defineProperty(event, 'reason', { value: new Error('lost promise') });
    window.dispatchEvent(event);
    remove();
    expect(posted(fetchMock)[0]).toMatchObject({ message: 'lost promise', where: 'unhandledrejection' });
  });

  it('a render error shows a fallback and is reported with the component stack', async () => {
    const fetchMock = mockFetch(() => ({ body: {} }));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    function Broken(): never { throw new Error('render exploded'); }
    renderWithI18n(<ErrorBoundary><Broken /></ErrorBoundary>);
    expect(await screen.findByText(t('errorBoundary.title'))).toBeTruthy();
    const body = posted(fetchMock)[0];
    expect(body).toMatchObject({ message: 'render exploded', where: 'render' });
    expect(body.component_stack).toContain('Broken');
  });
});

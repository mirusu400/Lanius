/**
 * Renders the real ProxyTab against a mocked engine (fetch + WebSocket) and
 * asserts the live history table and detail pane behave as expected.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { fireShortcut, renderWithI18n as render, t, tk, TEST_LOCALE } from '../test-utils';
import { useI18n, type Locale } from '../i18n';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProxyTab } from './ProxyTab';
import { clearSelection } from './selectionStore';
import { getTabs, resetTabs } from './replayStore';
import type { FlowSummary } from '../api/types';
import { useToast } from '../components/Toast';
import { TOAST_PREFERENCES_KEY } from '../toastPreferences';

function ToastControls() {
  const { dismissToast } = useToast();
  return <button onClick={dismissToast}>Dismiss feedback</button>;
}

const seeded: FlowSummary = {
  id: 'seed-1',
  request_number: 41,
  type: 'http',
  client_addr: '127.0.0.1:1',
  server_addr: '1.1.1.1:80',
  scheme: 'http',
  method: 'GET',
  host: 'seeded.test',
  port: 80,
  path: '/seeded',
  query: null,
  http_version: 'HTTP/1.1',
  request_size: 0,
  started_at: 1000,
  status_code: 200,
  reason: 'OK',
  response_size: 10,
  response_mime: 'text/html',
  completed_at: 1001,
  duration_ms: 12,
  error: null,
  source: 'proxy',
  comment: null,
};

const live: FlowSummary = {
  ...seeded,
  id: 'live-1',
  host: 'live.test',
  path: '/live',
  status_code: null,
  duration_ms: null,
};

class MockSocket {
  static instances: MockSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  url: string;

  constructor(url: string) {
    this.url = url;
    MockSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  emit(type: string, data: unknown) {
    this.onmessage?.({ data: JSON.stringify({ type, data }) });
  }
  close() {}
}

// Set by the locale test to make the next flow listing fail.
let failListFlows = false;
let failClearFlows = false;
let clearResponse: Promise<Response> | null = null;
let paginateHistory = false;
let importedHistory = false;
let searchResponse: Promise<Response> | null = null;
let flowPageResponse: Promise<Response> | null = null;
let calls: { url: string; method: string; body?: unknown; signal?: AbortSignal | null }[] = [];

beforeEach(() => {
  calls = [];
  window.localStorage.clear();
  // The selection lives outside the component so it survives a tab
  // switch, which also means it survives between tests.
  clearSelection();
  failListFlows = false;
  failClearFlows = false;
  clearResponse = null;
  paginateHistory = false;
  importedHistory = false;
  searchResponse = null;
  flowPageResponse = null;
  MockSocket.instances = [];
  vi.stubGlobal('WebSocket', MockSocket as unknown as typeof WebSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        signal: init?.signal,
      });
      // Before the /api/flows/ branch below: that prefix would otherwise
      // answer a delete with a flow.
      if (url.endsWith('/api/flows/delete')) {
        return jsonResponse({ deleted: 1 });
      }
      if (url.endsWith('/api/flows') && init?.method === 'DELETE') {
        if (failClearFlows) throw new Error('clear failed');
        if (clearResponse) return clearResponse;
        return jsonResponse({ ok: true });
      }
      if (url.endsWith('/annotation') && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as {
          bookmarked?: boolean;
          annotation_color?: string | null;
        };
        return jsonResponse({
          id: 'seed-1',
          bookmarked: body.bookmarked ?? false,
          annotation_color: Object.hasOwn(body, 'annotation_color')
            ? body.annotation_color
            : (body.bookmarked ? 'yellow' : null),
        });
      }
      if (url.includes('/api/status')) {
        return jsonResponse({
          version: '0.1.0',
          proxy: { running: true, host: '127.0.0.1', port: 8080 },
          flows: 1,
          subscribers: 1,
          db_path: '/tmp/x.sqlite',
        });
      }
      if (url.includes('/api/intercept')) {
        return jsonResponse({
          rules: {
            enabled: false,
            intercept_requests: true,
            intercept_responses: false,
            host_filter: null,
          },
          paused: [],
        });
      }
      if (url.includes('/api/flows/')) {
        return jsonResponse({
          ...seeded,
          request_headers: [
            ['Host', 'seeded.test'],
            ['Cookie', '<redacted>'],
          ],
          request_body: '',
          response_headers: [['Content-Type', 'text/html']],
          response_body: '<h1>hello lanius</h1>',
        });
      }
      if (failListFlows) {
        throw new Error('engine down');
      }
      if (searchResponse && url.includes('/api/flows?') && new URL(url).searchParams.has('search')) {
        return searchResponse;
      }
      if (flowPageResponse && url.includes('/api/flows?')) {
        return flowPageResponse;
      }
      if (importedHistory && url.includes('/api/flows?')) {
        return jsonResponse({ items: [{ ...seeded, id: 'imported', path: '/imported' }], count: 1, has_more: false, anchor: 2 });
      }
      if (paginateHistory && url.includes('/api/flows?')) {
        const offset = Number(new URL(url).searchParams.get('offset') ?? 0);
        return jsonResponse(offset === 0
          ? { items: [seeded], count: 1, has_more: true }
          : { items: [{ ...seeded, id: 'old-1', path: '/old' }], count: 1, has_more: false });
      }
      return jsonResponse({ items: [seeded], count: 1 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  } as Response;
}

describe('ProxyTab', () => {
  it('switches between side-by-side and stacked history layouts and remembers the choice', async () => {
    const user = userEvent.setup();
    const view = render(<ProxyTab />);
    await screen.findByText('seeded.test');

    const toggle = screen.getByRole('button', { name: t('proxy.switchToStackedLayout') });
    expect(document.querySelector('.proxy-split')?.classList.contains('split-h')).toBe(true);
    await user.click(toggle);

    expect(document.querySelector('.proxy-split')?.classList.contains('split-v')).toBe(true);
    expect(window.localStorage.getItem('lanius.layout.proxyHistory')).toBe('stacked');
    expect(screen.getByRole('button', { name: t('proxy.switchToSideBySideLayout') })).toBeTruthy();
    const count = screen.getByText(t('proxy.flowCount', { count: 1 }));
    expect(toggle.nextElementSibling).toBe(count);

    view.unmount();
    render(<ProxyTab />);
    await screen.findByText('seeded.test');
    expect(document.querySelector('.proxy-split')?.classList.contains('split-v')).toBe(true);
  });

  it('loads existing history from REST on mount', async () => {
    render(<ProxyTab />);
    expect(await screen.findByText('seeded.test')).toBeTruthy();
    expect(screen.getByText('/seeded')).toBeTruthy();
    expect(screen.getByText('41')).toBeTruthy();
  });

  it('applies the default highlight when a request is bookmarked', async () => {
    const user = userEvent.setup();
    render(<ProxyTab />);
    const row = (await screen.findByText('/seeded')).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: t('history.addBookmark') }));
    await waitFor(() => expect(row.classList.contains('annotation-yellow')).toBe(true));
    const call = calls.find((item) => item.url.endsWith('/annotation'));
    expect(call?.body).toEqual({ bookmarked: true });
  });

  it('removes the bookmark highlight when the bookmark is cleared', async () => {
    const user = userEvent.setup();
    render(<ProxyTab />);
    const row = (await screen.findByText('/seeded')).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: t('history.addBookmark') }));
    await user.click(await within(row).findByRole('button', { name: t('history.removeBookmark') }));

    await waitFor(() => expect(row.classList.contains('annotation-yellow')).toBe(false));
    const annotationCalls = calls.filter((item) => item.url.endsWith('/annotation'));
    expect(annotationCalls.at(-1)?.body).toEqual({ bookmarked: false, annotation_color: null });
  });

  it('keeps an intercept draft when switching between Proxy subtabs', async () => {
    const user = userEvent.setup();
    render(<ProxyTab />);
    await screen.findByText('seeded.test');
    MockSocket.instances[0].emit('intercept.paused', {
      id: 'held-1', phase: 'request', method: 'GET', scheme: 'http',
      host: 'example.com', port: 80, path: '/before', http_version: 'HTTP/1.1',
      request_headers: [['Host', 'example.com']], request_body: '',
    });
    MockSocket.instances[0].emit('intercept.paused', {
      id: 'held-2', phase: 'request', method: 'GET', scheme: 'http',
      host: 'example.com', port: 80, path: '/second', http_version: 'HTTP/1.1',
      request_headers: [['Host', 'example.com']], request_body: '',
    });
    await user.click(screen.getByRole('button', { name: new RegExp(t('proxy.intercept')) }));
    await user.click(within(screen.getByLabelText(t('intercept.queueLabel'))).getByRole('button', { name: /second/ }));
    const editor = document.querySelector('textarea.intercept-editor') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'POST /after HTTP/1.1\r\nHost: example.com\r\n\r\n' } });
    await user.click(screen.getByRole('button', { name: t('proxy.history') }));
    await user.click(screen.getByRole('button', { name: new RegExp(t('proxy.intercept')) }));
    expect((document.querySelector('textarea.intercept-editor') as HTMLTextAreaElement).value).toContain('/after');
  });

  it('keeps the Intercept queue filter when switching Proxy subtabs', async () => {
    const user = userEvent.setup();
    render(<ProxyTab />);
    await screen.findByText('seeded.test');
    MockSocket.instances[0].emit('intercept.paused', {
      id: 'held-1', phase: 'request', method: 'GET', scheme: 'http',
      host: 'example.com', port: 80, path: '/first', http_version: 'HTTP/1.1',
      request_headers: [['Host', 'example.com']], request_body: '',
    });
    await user.click(screen.getByRole('button', { name: new RegExp(t('proxy.intercept')) }));
    const search = screen.getByRole('textbox', { name: t('intercept.searchPlaceholder') });
    await user.type(search, 'missing');
    expect(screen.getAllByText(t('intercept.noFilterMatches')).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: t('proxy.history') }));
    await user.click(screen.getByRole('button', { name: new RegExp(t('proxy.intercept')) }));
    expect(screen.getByRole('textbox', { name: t('intercept.searchPlaceholder') })).toHaveProperty('value', 'missing');
    expect(screen.getAllByText(t('intercept.noFilterMatches')).length).toBeGreaterThan(0);
  });

  it('requests a full-history sort when a column header is clicked', async () => {
    const user = userEvent.setup();
    render(<ProxyTab />);
    await screen.findByText('seeded.test');
    const host = screen.getByRole('button', { name: t('flow.host') });
    await user.click(host);
    await waitFor(() => expect(calls.some((call) => {
      const url = new URL(call.url);
      return url.searchParams.get('sort_by') === 'host'
        && url.searchParams.get('sort_desc') === 'false';
    })).toBe(true));
    expect(host.closest('th')?.getAttribute('aria-sort')).toBe('ascending');
    await user.click(host);
    await waitFor(() => expect(calls.some((call) => {
      const url = new URL(call.url);
      return url.searchParams.get('sort_by') === 'host'
        && url.searchParams.get('sort_desc') === 'true';
    })).toBe(true));
  });

  it('selects adjacent history rows with arrow keys', async () => {
    const user = userEvent.setup();
    render(<ProxyTab />);
    await screen.findByText('seeded.test');
    MockSocket.instances[0].emit('flow.request', live);
    const table = document.querySelector('.flow-table-wrap') as HTMLDivElement;
    table.focus();
    await user.keyboard('{ArrowDown}');
    expect(document.querySelector('.flow-table tbody tr.selected')?.textContent).toContain('live.test');
    await user.keyboard('{ArrowDown}');
    expect(document.querySelector('.flow-table tbody tr.selected')?.textContent).toContain('seeded.test');
    await user.keyboard('{ArrowUp}');
    expect(document.querySelector('.flow-table tbody tr.selected')?.textContent).toContain('live.test');
  });

  it('highlights the history search in table cells and selected details', async () => {
    const user = userEvent.setup();
    render(<ProxyTab />);
    await screen.findByText('seeded.test');
    const search = screen.getByPlaceholderText(t('proxy.searchPlaceholder'));
    await user.type(search, 'seeded');
    await waitFor(() => expect(document.querySelector('.flow-table td mark')?.textContent).toBe('seeded'));
    await user.click(document.querySelector('.flow-table tbody tr')!);
    await waitFor(() => expect(document.querySelector('.detail-half .headers mark')?.textContent).toBe('seeded'));
  });

  it('shows search progress over the history list while a full-text search is pending', async () => {
    const user = userEvent.setup();
    render(<ProxyTab />);
    await screen.findByText('seeded.test');
    let finishSearch!: (response: Response) => void;
    searchResponse = new Promise<Response>((resolve) => { finishSearch = resolve; });

    await user.type(screen.getByPlaceholderText(t('proxy.searchPlaceholder')), 'needle');
    const progress = await screen.findByRole('status', { name: t('proxy.searching') });
    expect(screen.queryByText(t('toast.searchCompleted'))).toBeNull();
    expect(progress.closest('.split-pane')).toBe(document.querySelector('.proxy-split > .split-pane'));
    expect(screen.getByText('seeded.test')).toBeTruthy();

    finishSearch(jsonResponse({ items: [{ ...seeded, id: 'match', host: 'needle.test' }], count: 1 }));
    await waitFor(() => expect(document.querySelector('.flow-table tbody tr')?.textContent).toContain('needle.test'));
    await waitFor(() => expect(screen.queryByRole('status', { name: t('proxy.searching') })).toBeNull());
    expect(screen.getByText(t('toast.searchCompleted'))).toBeTruthy();
  });

  it.each(['bookmark', 'filter', 'sort', 'refresh', 'page', 'page size'] as const)(
    'shows query progress without a search term for %s changes', async (action) => {
      const user = userEvent.setup();
      paginateHistory = true;
      render(<ProxyTab />);
      await screen.findByText('seeded.test');
      let finish!: (response: Response) => void;
      flowPageResponse = new Promise<Response>((resolve) => { finish = resolve; });

      switch (action) {
        case 'bookmark':
          await user.click(screen.getByRole('button', { name: `★ ${t('history.bookmarkedOnly')}` }));
          break;
        case 'filter': {
          const before = calls.filter(({ url }) => url.includes('/api/flows?')).length;
          await user.click(screen.getByRole('button', { name: t('filter.button') }));
          expect(calls.filter(({ url }) => url.includes('/api/flows?'))).toHaveLength(before);
          const dialog = screen.getByRole('dialog', { name: t('filter.title') });
          await user.click(within(dialog).getByRole('checkbox', { name: 'GET' }));
          await user.click(within(dialog).getByRole('button', { name: t('filter.apply') }));
          break;
        }
        case 'sort':
          await user.click(screen.getByRole('button', { name: t('flow.host') }));
          break;
        case 'refresh':
          await user.click(screen.getByRole('button', { name: t('common.refresh') }));
          break;
        case 'page':
          await user.click(screen.getByRole('button', { name: t('proxy.olderHistory') }));
          break;
        case 'page size': {
          const input = screen.getByRole('spinbutton', { name: t('proxy.historyPageSize') });
          await user.clear(input);
          await user.type(input, '100{Enter}');
          break;
        }
      }

      await screen.findByRole('status', { name: t('proxy.searching') });
      expect(screen.getByText('seeded.test')).toBeTruthy();
      finish(jsonResponse({ items: [{ ...seeded, host: 'filtered.test' }], has_more: false }));
      await screen.findByText('filtered.test');
      await waitFor(() => expect(screen.queryByRole('status', { name: t('proxy.searching') })).toBeNull());
      expect(screen.queryByText(t('toast.searchCompleted'))).toBeNull();
      expect(screen.queryByText(t('toast.searchEmpty'))).toBeNull();
    },
  );

  it('searches the combined filters when bookmarks are toggled before the search debounce fires', async () => {
    const user = userEvent.setup();
    render(<ProxyTab />);
    await screen.findByText('seeded.test');
    let finish!: (response: Response) => void;
    searchResponse = new Promise<Response>((resolve) => { finish = resolve; });

    fireEvent.change(screen.getByPlaceholderText(t('proxy.searchPlaceholder')), { target: { value: 'needle' } });
    await user.click(screen.getByRole('button', { name: `★ ${t('history.bookmarkedOnly')}` }));
    await screen.findByRole('status', { name: t('proxy.searching') });

    finish(jsonResponse({ items: [{ ...seeded, host: 'needle.test', bookmarked: true }] }));
    await waitFor(() => expect(document.querySelector('.flow-table tbody tr')?.textContent).toContain('needle.test'));
    await waitFor(() => expect(screen.queryByRole('status', { name: t('proxy.searching') })).toBeNull());
    const searched = calls.filter(({ url }) => new URL(url).searchParams.get('search') === 'needle');
    expect(searched).toHaveLength(1);
    expect(new URL(searched[0].url).searchParams.get('bookmarked_only')).toBe('true');
  });

  it.each(['success', 'failure'] as const)(
    'keeps bookmark search progress when the superseded search settles with %s', async (outcome) => {
      const user = userEvent.setup();
      render(<ProxyTab />);
      await screen.findByText('seeded.test');
      let finishOld!: (response: Response) => void;
      let failOld!: (error: Error) => void;
      searchResponse = new Promise<Response>((resolve, reject) => { finishOld = resolve; failOld = reject; });
      await user.type(screen.getByPlaceholderText(t('proxy.searchPlaceholder')), 'needle');
      await screen.findByRole('status', { name: t('proxy.searching') });
      const oldRequest = calls.find(({ url }) => url.includes('search=needle'))!;

      let finishLatest!: (response: Response) => void;
      searchResponse = new Promise<Response>((resolve) => { finishLatest = resolve; });
      await user.click(screen.getByRole('button', { name: `★ ${t('history.bookmarkedOnly')}` }));
      expect(oldRequest.signal?.aborted).toBe(true);
      await act(async () => {
        if (outcome === 'success') finishOld(jsonResponse({ items: [{ ...seeded, host: 'stale.test' }] }));
        else failOld(new DOMException('Aborted', 'AbortError'));
        await new Promise((resolve) => window.setTimeout(resolve, 450));
      });
      expect(screen.getByRole('status', { name: t('proxy.searching') })).toBeTruthy();
      expect(screen.queryByText('stale.test')).toBeNull();
      expect(document.querySelector('.banner.error')).toBeNull();
      expect(screen.queryByText(t('toast.searchCompleted'))).toBeNull();

      finishLatest(jsonResponse({ items: [{ ...seeded, host: 'latest.test', bookmarked: true }] }));
      await screen.findByText('latest.test');
      await waitFor(() => expect(screen.queryByRole('status', { name: t('proxy.searching') })).toBeNull());
      expect(screen.getByText(t('toast.searchCompleted'))).toBeTruthy();
    },
  );

  it('settles progress on the latest bookmark result and ignores a later obsolete result', async () => {
    const user = userEvent.setup();
    render(<ProxyTab />);
    await screen.findByText('seeded.test');
    let finishOld!: (response: Response) => void;
    searchResponse = new Promise<Response>((resolve) => { finishOld = resolve; });
    await user.type(screen.getByPlaceholderText(t('proxy.searchPlaceholder')), 'needle');
    await screen.findByRole('status', { name: t('proxy.searching') });

    let finishLatest!: (response: Response) => void;
    searchResponse = new Promise<Response>((resolve) => { finishLatest = resolve; });
    await user.click(screen.getByRole('button', { name: `★ ${t('history.bookmarkedOnly')}` }));
    finishLatest(jsonResponse({ items: [{ ...seeded, host: 'latest.test', bookmarked: true }] }));
    await screen.findByText('latest.test');
    await waitFor(() => expect(screen.queryByRole('status', { name: t('proxy.searching') })).toBeNull());

    await act(async () => finishOld(jsonResponse({ items: [{ ...seeded, host: 'stale.test' }] })));
    expect(screen.getByText('latest.test')).toBeTruthy();
    expect(screen.queryByText('stale.test')).toBeNull();
  });

  it('clears query progress when the latest bookmark request fails', async () => {
    const user = userEvent.setup();
    render(<ProxyTab />);
    await screen.findByText('seeded.test');
    let fail!: (error: Error) => void;
    flowPageResponse = new Promise<Response>((_resolve, reject) => { fail = reject; });
    await user.click(screen.getByRole('button', { name: `★ ${t('history.bookmarkedOnly')}` }));
    await screen.findByRole('status', { name: t('proxy.searching') });

    fail(new Error('bookmark query failed'));
    await screen.findByText(t('proxy.engineUnreachable', { message: 'bookmark query failed' }));
    await waitFor(() => expect(screen.queryByRole('status', { name: t('proxy.searching') })).toBeNull());
    expect(screen.queryByText(t('toast.searchCompleted'))).toBeNull();
  });

  it('aborts a pending history query when the tab unmounts', async () => {
    const user = userEvent.setup();
    const view = render(<ProxyTab />);
    await screen.findByText('seeded.test');
    let finish!: (response: Response) => void;
    flowPageResponse = new Promise<Response>((resolve) => { finish = resolve; });
    await user.click(screen.getByRole('button', { name: `★ ${t('history.bookmarkedOnly')}` }));
    const request = calls.find(({ url }) => new URL(url).searchParams.has('bookmarked_only'))!;
    expect(request.signal?.aborted).toBe(false);

    view.unmount();
    expect(request.signal?.aborted).toBe(true);
    await act(async () => finish(jsonResponse({ items: [] })));
  });

  it('stops query progress and ignores the pending result when history is cleared', async () => {
    const user = userEvent.setup();
    render(<ProxyTab />);
    await screen.findByText('seeded.test');
    let finish!: (response: Response) => void;
    searchResponse = new Promise<Response>((resolve) => { finish = resolve; });
    await user.type(screen.getByPlaceholderText(t('proxy.searchPlaceholder')), 'needle');
    await screen.findByRole('status', { name: t('proxy.searching') });
    const request = calls.find(({ url }) => url.includes('search=needle'))!;

    await user.click(screen.getByRole('button', { name: t('common.clear') }));
    const dialog = screen.getByRole('dialog', { name: t('proxy.clearConfirmTitle') });
    await user.click(within(dialog).getByRole('button', { name: t('common.clear') }));
    await screen.findByText(t('proxy.cleared'));
    expect(request.signal?.aborted).toBe(true);
    await waitFor(() => expect(screen.queryByRole('status', { name: t('proxy.searching') })).toBeNull());
    await act(async () => finish(jsonResponse({ items: [seeded] })));
    expect(screen.queryByText('seeded.test')).toBeNull();
    expect(document.querySelector('.flow-table td.empty')).toBeTruthy();
    expect(screen.queryByText(t('toast.searchCompleted'))).toBeNull();
  });

  it('does not let a background refresh settle progress during the next search debounce', async () => {
    vi.useFakeTimers();
    try {
      render(<ProxyTab />);
      await act(async () => {});
      let finishOld!: (response: Response) => void;
      searchResponse = new Promise<Response>((resolve) => { finishOld = resolve; });
      const input = screen.getByPlaceholderText(t('proxy.searchPlaceholder'));
      fireEvent.change(input, { target: { value: 'needle' } });
      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
      expect(screen.getByRole('status', { name: t('proxy.searching') })).toBeTruthy();

      act(() => MockSocket.instances[0].emit('flow.request', live));
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
      let finishLatest!: (response: Response) => void;
      searchResponse = new Promise<Response>((resolve) => { finishLatest = resolve; });
      fireEvent.change(input, { target: { value: 'needle-next' } });
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      expect(calls.filter(({ url }) => new URL(url).searchParams.get('search') === 'needle-next')).toHaveLength(0);
      expect(screen.getByRole('status', { name: t('proxy.searching') })).toBeTruthy();

      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
      expect(calls.filter(({ url }) => new URL(url).searchParams.get('search') === 'needle-next')).toHaveLength(1);
      await act(async () => {
        finishLatest(jsonResponse({ items: [{ ...seeded, host: 'latest.test' }] }));
        finishOld(jsonResponse({ items: [{ ...seeded, host: 'stale.test' }] }));
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(450); });
      expect(screen.queryByRole('status', { name: t('proxy.searching') })).toBeNull();
      expect(screen.getByText('latest.test')).toBeTruthy();
      expect(screen.queryByText('stale.test')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not show search progress for a background reload caused by a new flow', async () => {
    const user = userEvent.setup();
    render(<><ProxyTab /><ToastControls /></>);
    await screen.findByText('seeded.test');

    let finishSearch!: (response: Response) => void;
    searchResponse = new Promise<Response>((resolve) => { finishSearch = resolve; });
    await user.type(screen.getByPlaceholderText(t('proxy.searchPlaceholder')), 'needle');
    await screen.findByRole('status', { name: t('proxy.searching') });
    finishSearch(jsonResponse({
      items: [{ ...seeded, id: 'match', host: 'needle.test' }],
      count: 1,
    }));
    await waitFor(() => expect(
      document.querySelector('.flow-table tbody tr')?.textContent,
    ).toContain('needle.test'));
    await waitFor(() => expect(
      screen.queryByRole('status', { name: t('proxy.searching') }),
    ).toBeNull());

    let finishBackground!: (response: Response) => void;
    expect(screen.getByText(t('toast.searchCompleted'))).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Dismiss feedback' }));
    searchResponse = new Promise<Response>((resolve) => { finishBackground = resolve; });
    MockSocket.instances[0].emit('flow.request', { ...live, host: 'needle-live.test' });
    await new Promise((resolve) => window.setTimeout(resolve, 800));
    expect(screen.queryByRole('status', { name: t('proxy.searching') })).toBeNull();

    finishBackground(jsonResponse({
      items: [{ ...seeded, id: 'background', host: 'needle-live.test' }],
      count: 1,
    }));
    await waitFor(() => expect(
      document.querySelector('.flow-table tbody tr')?.textContent,
    ).toContain('needle-live.test'));
    expect(screen.queryByText(t('toast.searchCompleted'))).toBeNull();
  });

  it('reports an empty completed search and honors the search notification preference', async () => {
    const user = userEvent.setup();
    const view = render(<ProxyTab />);
    await screen.findByText('seeded.test');
    searchResponse = Promise.resolve(jsonResponse({ items: [], has_more: false }));
    await user.type(screen.getByPlaceholderText(t('proxy.searchPlaceholder')), 'missing');
    expect(await screen.findByText(t('toast.searchEmpty'))).toBeTruthy();
    view.unmount();
    localStorage.setItem(TOAST_PREFERENCES_KEY, JSON.stringify({ search: false }));
    render(<ProxyTab />);
    await screen.findByText('seeded.test');
    await user.type(screen.getByPlaceholderText(t('proxy.searchPlaceholder')), 'missing');
    await waitFor(() => expect(document.querySelector('.flow-table tbody tr')?.textContent).not.toContain('seeded.test'));
    expect(screen.queryByText(t('toast.searchEmpty'))).toBeNull();
  });

  it('keeps search progress when a background reload supersedes a pending user search', async () => {
    const user = userEvent.setup();
    render(<ProxyTab />);
    await screen.findByText('seeded.test');

    let finishSearch!: (response: Response) => void;
    searchResponse = new Promise<Response>((resolve) => { finishSearch = resolve; });
    await user.type(screen.getByPlaceholderText(t('proxy.searchPlaceholder')), 'needle');
    await screen.findByRole('status', { name: t('proxy.searching') });

    const searchCalls = calls.filter(({ url }) => url.includes('search=needle')).length;
    MockSocket.instances[0].emit('flow.request', { ...live, host: 'needle-live.test' });
    await waitFor(() => expect(
      calls.filter(({ url }) => url.includes('search=needle')).length,
    ).toBeGreaterThan(searchCalls));
    expect(screen.getByRole('status', { name: t('proxy.searching') })).toBeTruthy();

    finishSearch(jsonResponse({
      items: [{ ...seeded, id: 'background', host: 'needle-live.test' }],
      count: 1,
    }));
    await waitFor(() => expect(
      screen.queryByRole('status', { name: t('proxy.searching') }),
    ).toBeNull());
  });

  it('keeps search progress while clearing a pending search restores history', async () => {
    const user = userEvent.setup();
    render(<ProxyTab />);
    await screen.findByText('seeded.test');

    let finishSearch!: (response: Response) => void;
    searchResponse = new Promise<Response>((resolve) => { finishSearch = resolve; });
    const search = screen.getByPlaceholderText(t('proxy.searchPlaceholder'));
    await user.type(search, 'needle');
    await screen.findByRole('status', { name: t('proxy.searching') });

    let finishRestore!: (response: Response) => void;
    flowPageResponse = new Promise<Response>((resolve) => { finishRestore = resolve; });
    const restoreCalls = calls.filter(({ url }) => (
      url.includes('/api/flows?') && !new URL(url).searchParams.has('search')
    )).length;
    await user.clear(search);
    await waitFor(() => expect(calls.filter(({ url }) => (
      url.includes('/api/flows?') && !new URL(url).searchParams.has('search')
    )).length).toBeGreaterThan(restoreCalls));
    expect(screen.getByRole('status', { name: t('proxy.searching') })).toBeTruthy();

    finishRestore(jsonResponse({ items: [seeded], count: 1 }));
    await waitFor(() => expect(
      screen.queryByRole('status', { name: t('proxy.searching') }),
    ).toBeNull());
    await act(async () => finishSearch(jsonResponse({ items: [], count: 0 })));
    expect(screen.queryByText(t('toast.searchCompleted'))).toBeNull();
    expect(screen.queryByText(t('toast.searchEmpty'))).toBeNull();
  });

  it('does not announce success when the latest search fails', async () => {
    render(<ProxyTab />);
    await screen.findByText('seeded.test');
    failListFlows = true;
    await userEvent.type(screen.getByPlaceholderText(t('proxy.searchPlaceholder')), 'needle');
    await screen.findByText(t('proxy.engineUnreachable', { message: 'engine down' }));
    expect(screen.queryByText(t('toast.searchCompleted'))).toBeNull();
    expect(screen.queryByText(t('toast.searchEmpty'))).toBeNull();
  });

  it('shows search progress while sorting searched history', async () => {
    const user = userEvent.setup();
    render(<ProxyTab />);
    await screen.findByText('seeded.test');

    searchResponse = Promise.resolve(jsonResponse({ items: [seeded], count: 1 }));
    await user.type(screen.getByPlaceholderText(t('proxy.searchPlaceholder')), 'seeded');
    await waitFor(() => expect(calls.some(({ url }) => url.includes('search=seeded'))).toBe(true));

    let finishSort!: (response: Response) => void;
    searchResponse = new Promise<Response>((resolve) => { finishSort = resolve; });
    await user.click(screen.getByRole('button', { name: t('flow.host') }));
    await screen.findByRole('status', { name: t('proxy.searching') });

    finishSort(jsonResponse({ items: [seeded], count: 1 }));
    await waitFor(() => expect(
      screen.queryByRole('status', { name: t('proxy.searching') }),
    ).toBeNull());
  });

  it('shows search progress while paging through searched history', async () => {
    const user = userEvent.setup();
    render(<ProxyTab />);
    await screen.findByText('seeded.test');

    searchResponse = Promise.resolve(jsonResponse({
      items: [seeded],
      count: 1,
      has_more: true,
    }));
    await user.type(screen.getByPlaceholderText(t('proxy.searchPlaceholder')), 'seeded');
    const older = screen.getByRole('button', { name: t('proxy.olderHistory') });
    await waitFor(() => expect((older as HTMLButtonElement).disabled).toBe(false));

    let finishPage!: (response: Response) => void;
    searchResponse = new Promise<Response>((resolve) => { finishPage = resolve; });
    await user.click(older);
    await screen.findByRole('status', { name: t('proxy.searching') });

    finishPage(jsonResponse({ items: [], count: 0, has_more: false }));
    await waitFor(() => expect(
      screen.queryByRole('status', { name: t('proxy.searching') }),
    ).toBeNull());
  });

  it('shows search progress for a manual refresh of searched history', async () => {
    const user = userEvent.setup();
    render(<ProxyTab />);
    await screen.findByText('seeded.test');

    searchResponse = Promise.resolve(jsonResponse({ items: [seeded], count: 1 }));
    await user.type(screen.getByPlaceholderText(t('proxy.searchPlaceholder')), 'seeded');
    await waitFor(() => expect(
      screen.queryByRole('status', { name: t('proxy.searching') }),
    ).toBeNull());

    let finishRefresh!: (response: Response) => void;
    searchResponse = new Promise<Response>((resolve) => { finishRefresh = resolve; });
    await user.click(screen.getByRole('button', { name: t('common.refresh') }));
    await screen.findByRole('status', { name: t('proxy.searching') });

    finishRefresh(jsonResponse({ items: [seeded], count: 1 }));
    await waitFor(() => expect(
      screen.queryByRole('status', { name: t('proxy.searching') }),
    ).toBeNull());
  });

  it('keeps refreshing a searched history while flows arrive faster than the reload delay', async () => {
    const user = userEvent.setup();
    render(<ProxyTab />);
    await screen.findByText('seeded.test');
    await user.type(screen.getByPlaceholderText(t('proxy.searchPlaceholder')), 'needle');
    await waitFor(() => expect(calls.some(({ url }) => url.includes('search=needle'))).toBe(true));
    const before = calls.filter(({ url }) => url.includes('search=needle')).length;

    // One flow every 100 ms for 1.2 s: a restarting debounce would never fire.
    for (let index = 0; index < 12; index += 1) {
      MockSocket.instances[0].emit('flow.request', { ...live, id: `burst-${index}` });
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    expect(calls.filter(({ url }) => url.includes('search=needle')).length).toBeGreaterThan(before);
  });

  it('pages into older history without holding every flow in the table', async () => {
    paginateHistory = true;
    const user = userEvent.setup();
    render(<ProxyTab />);
    await screen.findByText('/seeded');
    await user.click(screen.getByRole('button', { name: t('proxy.olderHistory') }));
    await screen.findByText('/old');
    expect(screen.queryByText('/seeded')).toBeNull();
    expect(calls.some((call) => call.url.includes('offset=200'))).toBe(true);
    await user.click(screen.getByRole('button', { name: t('proxy.newerHistory') }));
    await screen.findByText('/seeded');
    const page = screen.getByRole('spinbutton', { name: t('proxy.historyPageLabel') });
    await user.clear(page);
    await user.type(page, '10000');
    await user.click(screen.getByRole('button', { name: t('proxy.jumpToPage') }));
    await waitFor(() => expect(calls.some((call) =>
      call.url.includes('offset=1999800')
    )).toBe(true));
  });

  it('loads more than 200 rows and keeps the selected limit when live traffic arrives', async () => {
    const user = userEvent.setup();
    render(<ProxyTab />);
    await screen.findByText('/seeded');
    flowPageResponse = Promise.resolve(jsonResponse({
      items: Array.from({ length: 300 }, (_, index) => ({
        ...seeded, id: `history-${index}`, path: `/history-${index}`,
      })),
      has_more: false,
    }));

    const size = screen.getByRole('spinbutton', { name: t('proxy.historyPageSize') });
    expect(size).toHaveProperty('value', '200');
    await user.clear(size);
    await user.type(size, '300{Enter}');
    await screen.findByText('/history-299');
    expect(screen.getByText(t('proxy.flowCount', { count: 300 }))).toBeTruthy();
    expect(calls.some(({ url }) => new URL(url).searchParams.get('limit') === '300')).toBe(true);

    act(() => MockSocket.instances[0].emit('flow.request', live));
    expect(await screen.findByText('/live')).toBeTruthy();
    expect(screen.queryByText('/history-299')).toBeNull();
    expect(screen.getByText('/history-298')).toBeTruthy();
    expect(screen.getByText(t('proxy.flowCount', { count: 300 }))).toBeTruthy();
    expect(screen.getByRole('button', { name: t('proxy.olderHistory') })).toHaveProperty('disabled', false);
  });

  it('resets pagination on a page size change and uses the new size for offsets', async () => {
    flowPageResponse = Promise.resolve(jsonResponse({
      items: [seeded], has_more: true, anchor: 10, next_cursor: 'old-size-cursor',
    }));
    const user = userEvent.setup();
    render(<ProxyTab />);
    await screen.findByText('/seeded');
    await user.click(screen.getByRole('button', { name: t('proxy.olderHistory') }));
    expect(calls.some(({ url }) => new URL(url).searchParams.get('cursor') === 'old-size-cursor')).toBe(true);

    flowPageResponse = Promise.resolve(jsonResponse({ items: [seeded], has_more: true, anchor: 20 }));
    const before = calls.length;
    const size = screen.getByRole('spinbutton', { name: t('proxy.historyPageSize') });
    await user.clear(size);
    await user.type(size, '500');
    await user.tab();

    const resized = calls.slice(before).find(({ url }) => url.includes('/api/flows?'));
    expect(resized).toBeTruthy();
    const params = new URL(resized!.url).searchParams;
    expect(params.get('limit')).toBe('500');
    expect(params.has('offset')).toBe(false);
    expect(params.has('cursor')).toBe(false);
    expect(params.has('anchor')).toBe(false);
    const page = screen.getByRole('spinbutton', { name: t('proxy.historyPageLabel') });
    expect(page).toHaveProperty('value', '1');

    await user.click(screen.getByRole('button', { name: t('proxy.olderHistory') }));
    expect(calls.some(({ url }) => new URL(url).searchParams.get('offset') === '500')).toBe(true);
    await user.clear(page);
    await user.type(page, '4{Enter}');
    expect(calls.some(({ url }) => new URL(url).searchParams.get('offset') === '1500')).toBe(true);
  });

  it('rejects invalid row limits and accepts the engine maximum', async () => {
    const user = userEvent.setup();
    render(<ProxyTab />);
    await screen.findByText('/seeded');
    const size = screen.getByRole('spinbutton', { name: t('proxy.historyPageSize') });
    const before = calls.length;
    for (const value of ['', '0', '-1', '1.5', '1001']) {
      fireEvent.change(size, { target: { value } });
      fireEvent.blur(size);
      expect(size).toHaveProperty('value', '200');
    }
    expect(calls.slice(before).filter(({ url }) => url.includes('/api/flows?'))).toHaveLength(0);

    await user.clear(size);
    await user.type(size, '1000{Enter}');
    expect(calls.some(({ url }) => new URL(url).searchParams.get('limit') === '1000')).toBe(true);
    expect(size).toHaveProperty('value', '1000');
  });

  it('appends flows arriving over the WebSocket and updates them in place', async () => {
    render(<ProxyTab />);
    await screen.findByText('seeded.test');

    const socket = MockSocket.instances[0];
    expect(socket.url).toContain('/ws');

    socket.emit('flow.request', live);
    expect(await screen.findByText('live.test')).toBeTruthy();
    expect(screen.getByText('…')).toBeTruthy(); // pending status

    socket.emit('flow.response', { ...live, status_code: 500, duration_ms: 7 });
    await waitFor(() => expect(screen.getByText('500')).toBeTruthy());
    // still one row for that flow
    expect(screen.getAllByText('live.test')).toHaveLength(1);
  });

  it('marks requests changed by automatic or interactive modification', async () => {
    render(<ProxyTab />);
    await screen.findByText('seeded.test');
    MockSocket.instances[0].emit('flow.request', { ...live, modified: true });
    expect(await screen.findByText('✓')).toBeTruthy();
    expect(screen.getByText(t('flow.modified'))).toBeTruthy();
  });

  it('shows connection state and flow count', async () => {
    render(<ProxyTab />);
    await waitFor(() => expect(screen.getByText(t('proxy.live'))).toBeTruthy());
    expect(screen.getByText(t('proxy.flowCount', { count: 1 }))).toBeTruthy();
  });

  it('shows request and response together when a row is selected', async () => {
    // Both halves are on screen at once, so reading the response no
    // longer means losing sight of the request that caused it.
    const user = userEvent.setup();
    render(<ProxyTab />);
    await user.click(await screen.findByText('/seeded'));

    expect(await screen.findByText('<redacted>')).toBeTruthy();
    await waitFor(() => expect(
      document.querySelectorAll('.detail-half pre.body')[1]?.textContent,
    ).toBe('<h1>hello lanius</h1>'));
    expect(document.querySelectorAll('.detail-half')[1]?.querySelector('pre.body .hljs-name')?.textContent).toBe('h1');
  });

  it('pauses live updates when requested', async () => {
    const user = userEvent.setup();
    render(<ProxyTab />);
    await screen.findByText('seeded.test');
    await user.click(screen.getByRole('button', { name: t('common.pause') }));

    MockSocket.instances[0].emit('flow.request', live);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('live.test')).toBeNull();
  });

  it('reports errors in the language currently selected', async () => {
    // The error callbacks close over `t`, which is a new function whenever
    // the locale changes. A callback frozen with an empty dependency array
    // keeps the translator from the first render, so after switching
    // language the user is told what went wrong in the language they just
    // left. Render in one locale, switch, then force the error.
    const user = userEvent.setup();
    const other: Locale = TEST_LOCALE === 'en' ? 'ko' : 'en';

    function Harness() {
      const { setLocale } = useI18n();
      return (
        <>
          <button type="button" onClick={() => setLocale(other)}>
            switch
          </button>
          <ProxyTab />
        </>
      );
    }

    render(<Harness />);
    await screen.findByText('seeded.test');

    await user.click(screen.getByRole('button', { name: 'switch' }));

    // Now make the next reload fail, and trigger one through the filter bar.
    failListFlows = true;
    await user.type(screen.getByPlaceholderText(tk(other)('proxy.searchPlaceholder')), 'x');

    const expected = tk(other)('proxy.engineUnreachable', {
      message: 'engine down',
    });
    expect(await screen.findByText(expected)).toBeTruthy();
  });

  it('re-translates a banner that is already on screen', async () => {
    // The first bug was raising the message in the wrong language. This is
    // the other half: a banner raised before the switch keeps whatever it
    // was worded in, because the translated string sits in state. Errors
    // are stored as a key and translated at render instead.
    const user = userEvent.setup();
    const other: Locale = TEST_LOCALE === 'en' ? 'ko' : 'en';

    function Harness() {
      const { setLocale } = useI18n();
      return (
        <>
          <button type="button" onClick={() => setLocale(other)}>
            switch
          </button>
          <ProxyTab />
        </>
      );
    }

    render(<Harness />);
    await screen.findByText('seeded.test');

    // Raise the banner first, in the original language.
    failListFlows = true;
    await user.type(screen.getByPlaceholderText(t('proxy.searchPlaceholder')), 'x');
    const before = t('proxy.engineUnreachable', { message: 'engine down' });
    expect(await screen.findByText(before)).toBeTruthy();

    // Now switch. The visible banner must follow.
    await user.click(screen.getByRole('button', { name: 'switch' }));
    const after = tk(other)('proxy.engineUnreachable', { message: 'engine down' });
    expect(await screen.findByText(after)).toBeTruthy();
    expect(screen.queryByText(before)).toBeNull();
  });

  it('clears the table on flows.cleared', async () => {
    render(<ProxyTab />);
    await screen.findByText('seeded.test');
    MockSocket.instances[0].emit('flows.cleared', {});
    await waitFor(() => expect(screen.queryByText('seeded.test')).toBeNull());
  });

  it('resets the page, cursor and selection when another project is imported', async () => {
    paginateHistory = true;
    const user = userEvent.setup();
    render(<ProxyTab />);
    await screen.findByText('/seeded');
    await user.click(screen.getByRole('button', { name: t('proxy.olderHistory') }));
    await user.click(await screen.findByText('/old'));
    await screen.findByText('<redacted>');
    const previousCalls = calls.length;
    importedHistory = true;
    MockSocket.instances[0].emit('project.imported', { flows: 1, scope: 0, workspace: 0 });
    await screen.findByText('/imported');
    expect(screen.queryByText('/old')).toBeNull();
    expect(screen.getByText(t('detail.selectPrompt'))).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: t('proxy.historyPageLabel') })).toHaveProperty('value', '1');
    const reloads = calls.slice(previousCalls).filter((call) => call.url.includes('/api/flows?'));
    expect(reloads.length).toBeGreaterThan(0);
    expect(new URL(reloads[0].url).searchParams.has('anchor')).toBe(false);
    for (const { url } of reloads) {
      const params = new URL(url).searchParams;
      expect(Number(params.get('offset') ?? 0)).toBe(0);
      expect([null, '2']).toContain(params.get('anchor'));
      expect(params.has('cursor')).toBe(false);
    }
  });
});

describe('selection across tabs', () => {
  it('keeps the selected flow when the tab is unmounted and shown again', async () => {
    // React unmounts a tab when you switch away, so a selection held in
    // the component was gone the moment you looked at anything else.
    const user = userEvent.setup();
    const view = render(<ProxyTab />);
    await user.click(await screen.findByText('/seeded'));
    await screen.findByText('<redacted>');

    view.unmount();
    render(<ProxyTab />);

    expect(await screen.findByText('<redacted>')).toBeTruthy();
  });

  it('forgets the selection when the history is cleared', async () => {
    // That is the one case where the flow really is gone.
    const user = userEvent.setup();
    render(<ProxyTab />);
    await user.click(await screen.findByText('/seeded'));
    await screen.findByText('<redacted>');

    await user.click(screen.getByRole('button', { name: t('common.clear') }));
    const dialog = screen.getByRole('dialog', { name: t('proxy.clearConfirmTitle') });
    expect(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/api/flows'))).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: t('common.clear') }));

    expect(await screen.findByText(t('detail.selectPrompt'))).toBeTruthy();
    expect(await screen.findByText(t('proxy.cleared'))).toBeTruthy();
    expect(calls.filter((call) => call.method === 'DELETE' && call.url.endsWith('/api/flows'))).toHaveLength(1);
  });

  it('keeps history when the clear confirmation is cancelled', async () => {
    const user = userEvent.setup();
    render(<ProxyTab />);
    await screen.findByText('/seeded');

    await user.click(screen.getByRole('button', { name: t('common.clear') }));
    const dialog = screen.getByRole('dialog', { name: t('proxy.clearConfirmTitle') });
    expect(within(dialog).getByText(t('proxy.clearConfirmMessage'))).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: t('common.cancel') }));

    expect(screen.getByText('/seeded')).toBeTruthy();
    expect(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/api/flows'))).toBe(false);
  });

  it('keeps history and reports an error when clear fails', async () => {
    failClearFlows = true;
    const user = userEvent.setup();
    render(<ProxyTab />);
    await screen.findByText('/seeded');

    await user.click(screen.getByRole('button', { name: t('common.clear') }));
    await user.click(within(screen.getByRole('dialog', { name: t('proxy.clearConfirmTitle') }))
      .getByRole('button', { name: t('common.clear') }));

    expect(await screen.findByText(t('proxy.clearFailed', { message: 'clear failed' }))).toBeTruthy();
    expect(screen.getByText('/seeded')).toBeTruthy();
  });

  it('shows progress and waits for the clear response before the success toast', async () => {
    let finishClear: (response: Response) => void = () => {};
    clearResponse = new Promise<Response>((resolve) => { finishClear = resolve; });
    const user = userEvent.setup();
    render(<ProxyTab />);
    await screen.findByText('/seeded');

    await user.click(screen.getByRole('button', { name: t('common.clear') }));
    await user.click(within(screen.getByRole('dialog', { name: t('proxy.clearConfirmTitle') }))
      .getByRole('button', { name: t('common.clear') }));

    expect(screen.getByRole('button', { name: t('proxy.clearing') }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByText(t('proxy.cleared'))).toBeNull();
    finishClear(jsonResponse({ ok: true }));
    expect(await screen.findByText(t('proxy.cleared'))).toBeTruthy();
  });
});

describe('sending a flow onward', () => {
  it('sends a selected history row without opening its context menu', async () => {
    resetTabs();
    render(<ProxyTab />);
    const row = (await screen.findByText('/seeded')).closest('tr')!;
    fireEvent.click(row);
    fireShortcut('request.sendToReplay', row);
    await waitFor(() => expect(getTabs()).toHaveLength(1));
    expect(getTabs()[0].text).toContain('Host: seeded.test');
    expect(getTabs()[0].text).toContain('Cookie:');
    expect(screen.getByText(t('toast.requestTransferred', { tool: 'Replay' }))).toBeTruthy();
  });

  it('carries the headers and body, not just the request line', async () => {
    // The table row is a summary with neither, so without fetching the
    // full flow first the request arrived in Replay as one bare line,
    // missing everything that was being tested.
    const user = userEvent.setup();
    resetTabs();
    render(<ProxyTab />);
    const row = (await screen.findByText('/seeded')).closest('tr')!;
    fireEvent.contextMenu(row);
    await user.click(
      screen.getByRole('menuitem', { name: t('menu.sendToReplay') }),
    );

    await waitFor(() => expect(getTabs()).toHaveLength(1));
    const text = getTabs()[0].text;
    expect(text).toContain('Cookie:');
    expect(text).toContain('Host: seeded.test');
    expect(screen.getByText(t('toast.requestTransferred', { tool: 'Replay' }))).toBeTruthy();
  });

  it('adds the right-clicked history hostname as an Include rule', async () => {
    const user = userEvent.setup();
    render(<ProxyTab />);
    fireEvent.contextMenu((await screen.findByText('/seeded')).closest('tr')!);
    await user.hover(screen.getByRole('menuitem', { name: t('menu.scopeIncludeRule') }));
    fireEvent.click(await screen.findByRole('menuitem', { name: t('menu.scopeHostname') }));
    await waitFor(() => expect(calls.some((call) =>
      call.url.endsWith('/api/scope/rules') &&
      (call.body as { kind: string; host: string; path: string }).kind === 'include' &&
      (call.body as { kind: string; host: string; path: string }).host === 'seeded.test' &&
      (call.body as { kind: string; host: string; path: string }).path === '*'
    )).toBe(true));
  });
});

describe('deleting from the history', () => {
  const openMenu = async () => {
    resetTabs();
    render(<ProxyTab />);
    const row = (await screen.findByText('/seeded')).closest('tr')!;
    fireEvent.contextMenu(row);
  };

  it('removes the request the menu was opened on', async () => {
    const user = userEvent.setup();
    await openMenu();
    await user.click(screen.getByRole('menuitem', { name: t('menu.deleteFlow') }));
    await user.click(await screen.findByRole('button', { name: t('common.delete') }));
    await waitFor(() => {
      const call = calls.find((c) => c.url.endsWith('/api/flows/delete'));
      expect((call!.body as { ids: string[] }).ids).toEqual(['seed-1']);
    });
  });

  it('takes the row out of the table', async () => {
    // Without reloading: a reload jumps the list back to the top and
    // loses where the user was reading.
    const user = userEvent.setup();
    await openMenu();
    await user.click(screen.getByRole('menuitem', { name: t('menu.deleteFlow') }));
    await user.click(await screen.findByRole('button', { name: t('common.delete') }));
    await waitFor(() => expect(screen.queryByText('/seeded')).toBeNull());
  });

  it('asks before deleting', async () => {
    const user = userEvent.setup();
    await openMenu();
    await user.click(screen.getByRole('menuitem', { name: t('menu.deleteFlow') }));
    expect(calls.some((c) => c.url.endsWith('/api/flows/delete'))).toBe(false);
    expect(screen.getByText(t('delete.confirmFlow'))).toBeTruthy();
  });

  it('keeps the request when the confirmation is cancelled', async () => {
    const user = userEvent.setup();
    await openMenu();
    await user.click(screen.getByRole('menuitem', { name: t('menu.deleteFlow') }));
    await user.click(screen.getByRole('button', { name: t('common.cancel') }));
    expect(calls.some((c) => c.url.endsWith('/api/flows/delete'))).toBe(false);
    expect(screen.getByText('/seeded')).toBeTruthy();
  });
});

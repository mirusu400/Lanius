/** Renders the real Replay tab against a mocked engine. */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { fireShortcut, renderWithI18n as render, t, tk, TEST_LOCALE } from '../test-utils';
import type { Locale } from '../i18n';
import userEvent from '@testing-library/user-event';
import { Activity } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReplayTabView } from './ReplayTab';
import { resetTabs, sendToReplay, getTabs, setTabs } from './replayStore';
import { AUTO_FOLLOW_REDIRECTS_STORAGE_KEY } from './replayModel';
import type { FlowSummary } from '../api/types';
import { resetTarget, subscribeTarget, type FuzzerTarget } from './fuzzerStore';

const flow: FlowSummary = {
  id: 'f1',
  type: 'http',
  client_addr: null,
  server_addr: null,
  scheme: 'http',
  method: 'GET',
  host: 'echo.test',
  port: 80,
  path: '/hello',
  query: null,
  http_version: 'HTTP/1.1',
  request_size: 0,
  started_at: 1,
  status_code: 200,
  reason: 'OK',
  response_size: 0,
  response_mime: null,
  completed_at: null,
  duration_ms: null,
  error: null,
  source: 'proxy',
  comment: null,
};

let sent: unknown[] = [];

beforeEach(() => {
  resetTabs();
  sent = [];
  localStorage.removeItem(AUTO_FOLLOW_REDIRECTS_STORAGE_KEY);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          id: `r${sent.length}`,
          status_code: 201,
          reason: 'Created',
          headers: [['X-Server', 'echo']],
          body: `pong-${sent.length}`,
          size: 4,
          duration_ms: 9,
          error: null,
        }),
      } as Response;
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const editor = () => {
  let input = screen.queryByRole('textbox', { name: t('replay.request') });
  if (!input) {
    const raw = [...(document.querySelector('.request-editor')?.querySelectorAll('[role="tab"]') ?? [])]
      .find((node) => node.textContent === t('detail.view.raw'));
    if (raw) fireEvent.click(raw);
    input = screen.queryByRole('textbox', { name: t('replay.request') });
  }
  if (!input) throw new Error('Replay request editor is not ready');
  return input as HTMLTextAreaElement;
};

describe('ReplayTab', () => {
  it('shows the storage omission notice with response headers in raw and preview views', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ id: 'media', status_code: 200, reason: 'OK',
        headers: [['Content-Type', 'video/mp4']], body: '', body_omitted: true,
        size: 5 * 1024 * 1024, duration_ms: 9, error: null }),
    })));
    sendToReplay(flow);
    render(<ReplayTabView />);
    await waitFor(() => expect(editor()).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: t('replay.send') }));
    const notice = t('detail.mediaBodyOmitted', { size: '5.0 MB' });
    expect(await screen.findByText(notice)).toBeTruthy();
    expect(document.querySelector('.replay-response')?.textContent).toContain('Content-Type: video/mp4');
    expect(document.querySelector('.replay-response .hljs-attr')?.textContent).toBe('Content-Type');
    fireEvent.click(screen.getByRole('tab', { name: t('detail.view.preview') }));
    expect(screen.getByText(notice)).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/response-preview'))).toBe(false);
    expect(getTabs()[0].response?.body_omitted).toBe(true);
  });

  it('sends the edited draft to Fuzzer with the configured shortcut', async () => {
    resetTarget();
    sendToReplay(flow);
    render(<ReplayTabView />);
    await waitFor(() => expect(editor()).toBeTruthy());
    const draft = 'POST /edited HTTP/1.1\nHost: echo.test\n\nchanged';
    fireEvent.change(editor(), { target: { value: draft } });
    const sentTarget: { current: FuzzerTarget | null } = { current: null };
    const unsubscribe = subscribeTarget((target) => { sentTarget.current = target; });
    fireShortcut('request.sendToFuzzer', editor());
    expect(sentTarget.current).toMatchObject({ url: 'http://echo.test', template: draft });
    expect(screen.getByText(t('toast.requestTransferred', { tool: 'Fuzzer' }))).toBeTruthy();

    fireEvent.contextMenu(editor());
    expect(screen.getByRole('menuitem', { name: t('editor.sendToFuzzer') })).toBeTruthy();
    fireShortcut('request.sendToFuzzer', editor());
    unsubscribe();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(sentTarget.current).toMatchObject({ url: 'http://echo.test', template: draft, seq: 2 });
    expect(sent).toHaveLength(0);
  });

  it('shows guidance when there are no tabs', () => {
    render(<ReplayTabView />);
    expect(screen.getByText(t('replay.noTabs'))).toBeTruthy();
  });

  it('creates a new empty tab with +', async () => {
    const user = userEvent.setup();
    render(<ReplayTabView />);
    await user.click(screen.getByRole('button', { name: '+' }));
    expect(editor().value).toContain('GET / HTTP/1.1');
  });

  it('picks up a request pushed from the Proxy tab', async () => {
    render(<ReplayTabView />);
    sendToReplay(flow);
    await waitFor(() => expect(editor().value).toContain('GET /hello'));
    expect(screen.getByDisplayValue('http://echo.test')).toBeTruthy();
  });

  it('sends the edited request and shows the response', async () => {
    const user = userEvent.setup();
    render(<ReplayTabView />);
    sendToReplay(flow);
    await waitFor(() => expect(editor()).toBeTruthy());

    await user.clear(editor());
    await user.type(
      editor(),
      'POST /submit HTTP/1.1{enter}Host: echo.test{enter}{enter}a=1',
    );
    await user.click(screen.getByRole('button', { name: t('replay.send') }));

    await waitFor(() => expect(screen.getByText(/pong/)).toBeTruthy());
    expect(sent[0]).toEqual({
      url: 'http://echo.test/submit',
      method: 'POST',
      headers: [['Host', 'echo.test']],
      body: 'a=1',
    });
    expect(screen.getByText(/201 · 4 B · 9 ms/)).toBeTruthy();
  });

  it('follows one redirect on demand and keeps both exchanges', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      const first = sent.length === 1;
      return {
        ok: true,
        status: 200,
        json: async () => first
          ? { id: 'redirect', status_code: 302, reason: 'Found',
              headers: [['Location', '/next?step=2']], body: '', size: 0,
              duration_ms: 2, error: null }
          : { id: 'done', status_code: 200, reason: 'OK', headers: [],
              body: 'finished', size: 8, duration_ms: 3, error: null },
      } as Response;
    }));
    const user = userEvent.setup();
    render(<ReplayTabView />);
    sendToReplay(flow);
    await waitFor(() => expect(editor()).toBeTruthy());

    await user.click(screen.getByRole('button', { name: t('replay.send') }));
    const follow = await screen.findByRole('button', {
      name: t('replay.followRedirect'),
    });
    expect(follow.title).toBe('http://echo.test/next?step=2');
    await user.click(follow);

    await screen.findByText(/finished/);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({
      url: 'http://echo.test/next?step=2',
      method: 'GET',
      headers: [['Host', 'echo.test']],
    });
    expect(getTabs()[0].history).toHaveLength(2);
    expect(editor().value).toContain('GET /next?step=2 HTTP/1.1');
  });

  it('does not offer a redirect from a response after its request is edited', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 'redirect', status_code: 302, reason: 'Found',
        headers: [['Location', '/next']], body: '', size: 0,
        duration_ms: 1, error: null }),
    } as Response)));
    const user = userEvent.setup();
    render(<ReplayTabView />);
    sendToReplay(flow);
    await waitFor(() => expect(editor()).toBeTruthy());
    await user.click(screen.getByRole('button', { name: t('replay.send') }));
    expect(await screen.findByRole('button', {
      name: t('replay.followRedirect'),
    })).toBeTruthy();

    fireEvent.change(editor(), {
      target: { value: 'GET /edited HTTP/1.1\nHost: echo.test\n\n' },
    });
    expect(screen.queryByRole('button', {
      name: t('replay.followRedirect'),
    })).toBeNull();
  });

  it('automatically follows redirects when the saved option is enabled', async () => {
    localStorage.setItem(AUTO_FOLLOW_REDIRECTS_STORAGE_KEY, '1');
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      const responses = [
        { id: 'r1', status_code: 302, reason: 'Found',
          headers: [['Location', '/middle']], body: '', size: 0,
          duration_ms: 1, error: null },
        { id: 'r2', status_code: 307, reason: 'Temporary Redirect',
          headers: [['Location', '/final']], body: '', size: 0,
          duration_ms: 1, error: null },
        { id: 'r3', status_code: 200, reason: 'OK', headers: [],
          body: 'automatic finish', size: 16, duration_ms: 1, error: null },
      ];
      return { ok: true, status: 200, json: async () => responses[sent.length - 1] } as Response;
    }));
    const user = userEvent.setup();
    render(<ReplayTabView />);
    sendToReplay(flow);
    await waitFor(() => expect(editor()).toBeTruthy());
    expect(screen.getByRole('checkbox', {
      name: t('replay.autoFollowRedirects'),
    })).toHaveProperty('checked', true);

    await user.click(screen.getByRole('button', { name: t('replay.send') }));
    await screen.findByText(/automatic finish/);

    expect(sent).toHaveLength(3);
    expect(sent.map((request) => (request as { url: string }).url)).toEqual([
      'http://echo.test/hello',
      'http://echo.test/middle',
      'http://echo.test/final',
    ]);
    expect(getTabs()[0].history).toHaveLength(3);
  });

  it('stops automatic following on a redirect loop', async () => {
    localStorage.setItem(AUTO_FOLLOW_REDIRECTS_STORAGE_KEY, '1');
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      const location = sent.length === 1 ? '/next' : '/hello';
      return { ok: true, status: 200, json: async () => ({
        id: `loop-${sent.length}`, status_code: 302, reason: 'Found',
        headers: [['Location', location]], body: '', size: 0,
        duration_ms: 1, error: null,
      }) } as Response;
    }));
    const user = userEvent.setup();
    render(<ReplayTabView />);
    sendToReplay(flow);
    await waitFor(() => expect(editor()).toBeTruthy());

    await user.click(screen.getByRole('button', { name: t('replay.send') }));
    expect(await screen.findByText(t('replay.redirectLoop'))).toBeTruthy();
    expect(sent).toHaveLength(2);
    expect(getTabs()[0].history).toHaveLength(2);
  });

  it('bounds automatic redirect chains', async () => {
    localStorage.setItem(AUTO_FOLLOW_REDIRECTS_STORAGE_KEY, '1');
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return { ok: true, status: 200, json: async () => ({
        id: `hop-${sent.length}`, status_code: 302, reason: 'Found',
        headers: [['Location', `/hop-${sent.length}`]], body: '', size: 0,
        duration_ms: 1, error: null,
      }) } as Response;
    }));
    const user = userEvent.setup();
    render(<ReplayTabView />);
    sendToReplay(flow);
    await waitFor(() => expect(editor()).toBeTruthy());

    await user.click(screen.getByRole('button', { name: t('replay.send') }));
    expect(await screen.findByText(t('replay.redirectLimit', { count: 10 })))
      .toBeTruthy();
    expect(sent).toHaveLength(11);
    expect(getTabs()[0].history).toHaveLength(11);
  });

  it('does not overwrite an edit made while an automatic redirect is in flight', async () => {
    localStorage.setItem(AUTO_FOLLOW_REDIRECTS_STORAGE_KEY, '1');
    let finish: (response: Response) => void = () => undefined;
    vi.stubGlobal('fetch', vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Promise<Response>((resolve) => { finish = resolve; });
    }));
    const user = userEvent.setup();
    render(<ReplayTabView />);
    sendToReplay(flow);
    await waitFor(() => expect(editor()).toBeTruthy());
    await user.click(screen.getByRole('button', { name: t('replay.send') }));
    fireEvent.change(editor(), {
      target: { value: 'GET /my-draft HTTP/1.1\nHost: echo.test\n\n' },
    });
    finish({ ok: true, status: 200, json: async () => ({
      id: 'late-redirect', status_code: 302, reason: 'Found',
      headers: [['Location', '/automatic']], body: '', size: 0,
      duration_ms: 1, error: null,
    }) } as Response);

    await waitFor(() => expect(getTabs()[0].history).toHaveLength(1));
    expect(sent).toHaveLength(1);
    expect(editor().value).toContain('/my-draft');
  });

  it('persists the automatic redirect option', async () => {
    const user = userEvent.setup();
    render(<ReplayTabView />);
    sendToReplay(flow);
    const toggle = await screen.findByRole('checkbox', {
      name: t('replay.autoFollowRedirects'),
    });
    await user.click(toggle);
    expect(localStorage.getItem(AUTO_FOLLOW_REDIRECTS_STORAGE_KEY)).toBe('1');
  });

  it('undoes and redoes edits in the request body', async () => {
    const user = userEvent.setup();
    render(<ReplayTabView />);
    sendToReplay(flow);
    await waitFor(() => expect(editor()).toBeTruthy());
    const original = editor().value;
    const originalStored = getTabs()[0].text;
    editor().setSelectionRange(original.length, original.length);

    await user.type(editor(), 'changed');
    expect(getTabs()[0].text).toBe(`${original}changed`);
    fireEvent.keyDown(editor(), { key: 'z', code: 'KeyZ', ctrlKey: true });
    expect(editor().value).toBe(original);
    expect(getTabs()[0].text).toBe(originalStored);
    fireEvent.keyDown(editor(), { key: 'y', code: 'KeyY', ctrlKey: true });
    expect(editor().value).toBe(`${original}changed`);
    expect(getTabs()[0].text).toBe(`${original}changed`);
  });

  it('browses saved request and response pairs and restores an unsent edit', async () => {
    const user = userEvent.setup();
    render(<ReplayTabView />);
    sendToReplay(flow);
    await waitFor(() => expect(editor()).toBeTruthy());

    await user.click(screen.getByRole('button', { name: t('replay.send') }));
    await screen.findByText(/pong-1/);
    fireEvent.change(editor(), { target: { value: 'GET /second HTTP/1.1\nHost: echo.test\n\n' } });
    await user.click(screen.getByRole('button', { name: t('replay.send') }));
    await screen.findByText(/pong-2/);

    expect(getTabs()[0].history).toHaveLength(2);
    expect(screen.getByText(t('replay.historyPosition', { current: 2, total: 2 }))).toBeTruthy();
    await user.click(screen.getByRole('button', { name: t('replay.previousHistory') }));
    expect(editor().value).toContain('GET /hello');
    expect(screen.getByText(/pong-1/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: t('replay.nextHistory') }));
    expect(editor().value).toContain('GET /second');
    expect(screen.getByText(/pong-2/)).toBeTruthy();

    fireEvent.change(editor(), { target: { value: 'GET /draft HTTP/1.1\nHost: echo.test\n\n' } });
    expect(screen.getByText(t('replay.historyDraft'))).toBeTruthy();
    await user.click(screen.getByRole('button', { name: t('replay.previousHistory') }));
    expect(editor().value).toContain('GET /second');
    await user.click(screen.getByRole('button', { name: t('replay.nextHistory') }));
    expect(editor().value).toContain('GET /draft');

    const saved = JSON.parse(JSON.stringify(getTabs()));
    cleanup();
    resetTabs();
    setTabs(saved);
    render(<ReplayTabView />);
    await waitFor(() => expect(editor().value).toContain('GET /draft'));
    await user.click(screen.getByRole('button', { name: t('replay.previousHistory') }));
    expect(editor().value).toContain('GET /second');
    expect(screen.getByText(/pong-2/)).toBeTruthy();
  });

  it('keeps the sent bytes in history when the editor changes before the response arrives', async () => {
    let finish: (response: Response) => void = () => undefined;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      if (!String(input).includes('/api/replay/send')) {
        return Promise.resolve({ ok: true, json: async () => ({ actions: [] }) } as Response);
      }
      return new Promise<Response>((resolve) => { finish = resolve; });
    }));

    const user = userEvent.setup();
    render(<ReplayTabView />);
    sendToReplay(flow);
    await waitFor(() => expect(editor()).toBeTruthy());
    await user.click(screen.getByRole('button', { name: t('replay.send') }));
    fireEvent.change(editor(), { target: { value: 'GET /draft HTTP/1.1\nHost: echo.test\n\n' } });
    finish({
      ok: true, status: 200, json: async () => ({
        id: 'late', status_code: 200, reason: 'OK', headers: [],
        body: 'late response', size: 13, duration_ms: 1, error: null,
      }),
    } as Response);

    await waitFor(() => expect(getTabs()[0].history).toHaveLength(1));
    expect(editor().value).toContain('GET /draft');
    await user.click(screen.getByRole('button', { name: t('replay.previousHistory') }));
    expect(editor().value).toContain('GET /hello');
    expect(screen.getByText(/late response/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: t('replay.nextHistory') }));
    expect(editor().value).toContain('GET /draft');
  });

  it('makes a saved response from an older project the first history entry', async () => {
    setTabs([{
      id: 'old', title: 'old', url: 'http://echo.test',
      text: 'GET /old HTTP/1.1\nHost: echo.test\n\n',
      response: { id: 'old-response', status_code: 200, reason: 'OK',
        headers: [], body: 'saved body', size: 10, duration_ms: 1, error: null },
      sending: false, error: null,
    }]);
    render(<ReplayTabView />);
    expect(await screen.findByText(/saved body/)).toBeTruthy();
    expect(getTabs()[0].history).toHaveLength(1);
    expect(screen.getByText(t('replay.historyPosition', { current: 1, total: 1 }))).toBeTruthy();
  });

  it('reports malformed requests without calling the engine', async () => {
    const user = userEvent.setup();
    render(<ReplayTabView />);
    sendToReplay(flow);
    await waitFor(() => expect(editor()).toBeTruthy());
    await user.clear(editor());
    await user.type(editor(), 'OOPS');
    await user.click(screen.getByRole('button', { name: t('replay.send') }));
    expect(await screen.findByText(t('parse.badRequestLine'))).toBeTruthy();
    expect(sent).toHaveLength(0);
  });

  it('keeps a saved error translatable across a restart in another language', async () => {
    // Replay tabs are autosaved into the project and restored later,
    // possibly with a different language selected. Storing the translated
    // sentence would pin the old language into the saved file, so the tab
    // holds the key instead.
    const user = userEvent.setup();
    const other: Locale = TEST_LOCALE === 'en' ? 'ko' : 'en';

    const { unmount } = render(<ReplayTabView />);
    sendToReplay(flow);
    await waitFor(() => expect(editor()).toBeTruthy());
    await user.clear(editor());
    await user.type(editor(), 'OOPS');
    await user.click(screen.getByRole('button', { name: t('replay.send') }));
    await screen.findByText(t('parse.badRequestLine'));

    // Round-trip through the same JSON the autosave writes.
    const saved = JSON.parse(JSON.stringify(getTabs()));
    unmount();
    cleanup();
    resetTabs();
    setTabs(saved);

    // Reopen in the other language: the banner must be in that language.
    render(<ReplayTabView />, { locale: other });
    expect(await screen.findByText(tk(other)('parse.badRequestLine'))).toBeTruthy();
    expect(screen.queryByText(t('parse.badRequestLine'))).toBeNull();
  });

  it('switches to the tab that was clicked, even after a restart', async () => {
    // Tab ids came from a counter that restarted with the process, so a
    // restored project could hold several tabs called rt-1. Clicking the
    // later one activated the earlier, which looks like tab switching
    // being broken.
    const user = userEvent.setup();
    resetTabs();
    setTabs([
      { id: 'rt-1', title: 'first', url: 'http://a.test/', text: 'GET / HTTP/1.1',
        response: null, sending: false, error: null },
      { id: 'rt-1', title: 'second', url: 'http://b.test/', text: 'GET /b HTTP/1.1',
        response: null, sending: false, error: null },
      { id: 'rt-2', title: 'third', url: 'http://c.test/', text: 'GET /c HTTP/1.1',
        response: null, sending: false, error: null },
    ]);

    // The collision is repaired on load, so every tab is reachable.
    expect(new Set(getTabs().map((tab) => tab.id)).size).toBe(3);

    render(<ReplayTabView />);
    // The close control carries the title too, so pick the tab itself.
    const tab = (title: string) =>
      screen
        .getAllByRole('button', { name: new RegExp(title) })
        .find((node) => node.classList.contains('close') === false)!;

    await user.click(tab('second'));
    await waitFor(() =>
      expect(editor().value).toContain('GET /b HTTP/1.1'),
    );

    await user.click(tab('third'));
    await waitFor(() => expect(editor().value).toContain('GET /c HTTP/1.1'));
  });

  it('restores a project saved before errors became messages', async () => {
    // Those files hold the translated sentence as a bare string. It cannot
    // be re-translated, but it must still render rather than appear as
    // '[object Object]'.
    resetTabs();
    setTabs([
      {
        id: 'old',
        title: 'old tab',
        url: 'http://legacy.test/',
        text: 'GET / HTTP/1.1',
        response: null,
        sending: false,
        error: 'a sentence saved by an older build' as unknown as never,
      },
    ]);

    render(<ReplayTabView />);
    expect(
      await screen.findByText('a sentence saved by an older build'),
    ).toBeTruthy();
  });

  it('supports multiple independent tabs', async () => {
    const user = userEvent.setup();
    render(<ReplayTabView />);
    sendToReplay(flow);
    sendToReplay({ ...flow, id: 'f2', path: '/second' });
    // wait on the DOM, not the store, so React effects have flushed
    await waitFor(() => expect(editor()?.value).toContain('/second'));
    expect(getTabs()).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'GET /hello' }));
    expect(editor().value).toContain('/hello');
  });

  it('renames a request tab by double-clicking its title', async () => {
    const user = userEvent.setup();
    sendToReplay(flow);
    render(<ReplayTabView />);

    await user.dblClick(screen.getByText('GET /hello'));
    const name = screen.getByRole('textbox', {
      name: t('common.renameTab', { title: 'GET /hello' }),
    });
    await user.clear(name);
    await user.type(name, 'Login probe{Enter}');

    expect(screen.getByText('Login probe')).toBeTruthy();
    expect(getTabs()[0].title).toBe('Login probe');
  });

  it('shows a newly transferred request while an older Replay tab is selected', async () => {
    const user = userEvent.setup();
    const view = (visible: boolean) => <Activity mode={visible ? 'visible' : 'hidden'}><ReplayTabView /></Activity>;
    const { rerender } = render(view(true));
    sendToReplay(flow);
    sendToReplay({ ...flow, id: 'f2', path: '/older' });
    await waitFor(() => expect(editor().value).toContain('/older'));

    await user.click(screen.getByText('GET /hello').closest('button')!);
    expect(editor().value).toContain('/hello');

    rerender(view(false));
    sendToReplay({ ...flow, id: 'f3', path: '/newest' });
    rerender(view(true));
    await waitFor(() => expect(editor().value).toContain('/newest'));
    expect(document.querySelector('.replay-tabs button.active .tab-title')?.textContent).toBe('GET /newest');
  });

  it('copies the request URL from the editor context menu', async () => {
    const user = userEvent.setup();
    render(<ReplayTabView />);
    sendToReplay(flow);
    await waitFor(() => expect(editor()).toBeTruthy());

    fireEvent.contextMenu(editor());
    await user.click(screen.getByRole('menuitem', { name: t('menu.copyUrl') }));
    expect(await navigator.clipboard.readText()).toBe('http://echo.test/hello');
  });

  it('adds the edited Replay path as an Exclude rule', async () => {
    const user = userEvent.setup();
    render(<ReplayTabView />);
    sendToReplay(flow);
    await waitFor(() => expect(editor()).toBeTruthy());
    fireEvent.change(editor(), { target: { value: 'GET /edited?q=1 HTTP/1.1\nHost: echo.test\n\n' } });
    fireEvent.contextMenu(editor());
    await user.hover(screen.getByRole('menuitem', { name: t('menu.scopeExcludeRule') }));
    fireEvent.click(await screen.findByRole('menuitem', { name: t('menu.scopePath') }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input, init]) =>
      String(input).endsWith('/api/scope/rules') &&
      JSON.parse(String(init?.body)).path === '/edited*' &&
      JSON.parse(String(init?.body)).kind === 'exclude'
    )).toBe(true));
  });

  it('copies the right-clicked Replay tab URL without changing the selected tab', async () => {
    const user = userEvent.setup();
    render(<ReplayTabView />);
    sendToReplay(flow);
    sendToReplay({ ...flow, id: 'f2', path: '/second' });
    await waitFor(() => expect(editor().value).toContain('/second'));

    fireEvent.contextMenu(screen.getByText('GET /hello').closest('button')!);
    await user.click(screen.getByRole('menuitem', { name: t('menu.copyUrl') }));
    expect(await navigator.clipboard.readText()).toBe('http://echo.test/hello');
    expect(editor().value).toContain('/second');
  });

  it('closes a tab', async () => {
    const user = userEvent.setup();
    render(<ReplayTabView />);
    sendToReplay(flow);
    await waitFor(() => expect(editor()).toBeTruthy());
    await user.click(screen.getByLabelText(t('replay.closeTab', { title: 'GET /hello' })));
    await waitFor(() => expect(getTabs()).toHaveLength(0));
  });
});

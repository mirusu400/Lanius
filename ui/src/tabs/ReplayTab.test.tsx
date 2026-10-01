/** Renders the real Replay tab against a mocked engine. */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithI18n as render, t, tk, TEST_LOCALE } from '../test-utils';
import type { Locale } from '../i18n';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReplayTabView } from './ReplayTab';
import { resetTabs, sendToReplay, getTabs, setTabs } from './replayStore';
import type { FlowSummary } from '../api/types';

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

const editor = () =>
  screen.getByRole('textbox', { name: t('replay.request') }) as HTMLTextAreaElement;

describe('ReplayTab', () => {
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
    const [helloTab] = screen
      .getAllByRole('button')
      .filter((b) => b.textContent === 'GET /hello×');
    await user.click(helloTab);
    expect(editor().value).toContain('/hello');
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

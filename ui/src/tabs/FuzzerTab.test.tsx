/** Renders the real Fuzzer tab against a mocked engine. */
import { Activity, useState } from 'react';
import {cleanup, screen, waitFor, fireEvent } from '@testing-library/react';
import { fireShortcut, renderWithI18n as render, t } from '../test-utils';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FuzzerTab } from './FuzzerTab';
import { getFuzzerWorkspace, newFuzzerDraft, resetTarget, sendToFuzzer, setFuzzerWorkspace } from './fuzzerStore';
import type { RunResult, FlowSummary } from '../api/types';
import { getTabs, resetTabs } from './replayStore';

let started: { url: string; mode: string; payload_sets: string[][] }[] =
  [];
let results: RunResult[] = [];
let status = 'completed';

const flow: FlowSummary = {
  id: 'f1',
  type: 'http',
  client_addr: null,
  server_addr: null,
  scheme: 'http',
  method: 'GET',
  host: 'app.test',
  port: 80,
  path: '/login',
  query: 'pw=guess',
  http_version: 'HTTP/1.1',
  request_size: 0,
  started_at: 1,
  status_code: 403,
  reason: 'Forbidden',
  response_size: 6,
  response_mime: null,
  completed_at: null,
  duration_ms: null,
  error: null,
  source: 'proxy',
  comment: null,
};

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  } as Response;
}

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
  close() {}
}

beforeEach(() => {
  MockSocket.instances = [];
  resetTabs();
  resetTarget();
  started = [];
  status = 'completed';
  results = [
    {
      index: 0,
      payloads: ['wrong'],
      status_code: 403,
      length: 6,
      duration_ms: 3,
      error: null,
      flow_id: 'r0',
    },
    {
      index: 1,
      payloads: ['letmein'],
      status_code: 200,
      length: 13,
      duration_ms: 4,
      error: null,
      flow_id: 'r1',
    },
    {
      index: 2,
      payloads: ['nope'],
      status_code: 403,
      length: 6,
      duration_ms: 5,
      error: null,
      flow_id: 'r2',
    },
  ];
  vi.stubGlobal('WebSocket', MockSocket as unknown as typeof WebSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (url.includes('/api/flows/')) {
        const parts = new URL(url).pathname.split('/');
        const id = parts.at(-1) === 'replay-request' ? parts.at(-2) : parts.at(-1);
        return jsonResponse({
          ...flow, id,
          request_headers: [['Host', 'app.test']],
          request_body: `captured-request-${id}`,
          response_headers: [], response_body: 'captured-response',
        });
      }
      if (url.endsWith('/api/fuzzer/runs') && init?.method === 'POST') {
        started.push(body);
        return jsonResponse({
          id: 'atk1',
          mode: body.mode,
          url: body.url,
          status,
          total: results.length,
          completed: 0,
          started_at: 1,
          finished_at: null,
          error: null,
        });
      }
      if (url.endsWith('/api/fuzzer/runs')) {
        return jsonResponse({ items: [{
          id: 'atk1', mode: 'single_position', url: 'http://app.test',
          status, total: results.length, completed: results.length,
          started_at: 1, finished_at: 2, error: null,
        }] });
      }
      if (url.includes('/api/fuzzer/runs/atk1')) {
        return jsonResponse({
          id: 'atk1',
          mode: 'single_position',
          url: 'http://app.test',
          status,
          total: results.length,
          completed: results.length,
          started_at: 1,
          finished_at: 2,
          error: null,
          template: 'GET /saved?q={{x}} HTTP/1.1\nHost: app.test\n\n',
          payload_sets: [['wrong', 'letmein', 'nope']],
          speed: { concurrency: 5, delay: 0 },
          results,
        });
      }
      return jsonResponse({});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const templateBox = () => {
  let input = screen.queryByRole('textbox', { name: t('fuzzer.templateLabel') });
  if (!input) {
    const activePane = [...document.querySelectorAll<HTMLElement>('.fuzzer-tab')]
      .find((node) => node.style.display !== 'none');
    const raw = [...(activePane?.querySelector('.request-editor')?.querySelectorAll('[role="tab"]') ?? [])]
      .find((node) => node.textContent === t('detail.view.raw'));
    if (raw) fireEvent.click(raw);
    input = screen.queryByRole('textbox', { name: t('fuzzer.templateLabel') });
  }
  if (!input) throw new Error('Fuzzer request editor is not ready');
  return input as HTMLTextAreaElement;
};

describe('FuzzerTab', () => {
  it('shares URL copy and send to Replay actions with the other request editors', async () => {
    const user = userEvent.setup();
    sendToFuzzer(flow);
    render(<FuzzerTab />);
    await waitFor(() => expect(templateBox().value).toContain('/login?pw=guess'));

    fireEvent.contextMenu(templateBox());
    await user.click(screen.getByRole('menuitem', { name: t('menu.copyUrl') }));
    expect(await navigator.clipboard.readText()).toBe('http://app.test/login?pw=guess');

    fireEvent.contextMenu(templateBox());
    await user.click(screen.getByRole('menuitem', { name: t('menu.sendToReplay') }));
    expect(getTabs()[0].text).toContain('/login?pw=guess');
  });

  it('adds the template hostname as an Exclude rule', async () => {
    const user = userEvent.setup();
    sendToFuzzer(flow);
    render(<FuzzerTab />);
    await waitFor(() => expect(templateBox().value).toContain('/login'));
    fireEvent.contextMenu(templateBox());
    await user.hover(screen.getByRole('menuitem', { name: t('menu.scopeExcludeRule') }));
    fireEvent.click(await screen.findByRole('menuitem', { name: t('menu.scopeHostname') }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input, init]) =>
      String(input).endsWith('/api/scope/rules') &&
      JSON.parse(String(init?.body)).host === 'app.test' &&
      JSON.parse(String(init?.body)).kind === 'exclude'
    )).toBe(true));
  });
  it('replaces editor state when an imported workspace reuses a tab id', async () => {
    const draft = newFuzzerDraft('http://old.test', 'GET /old HTTP/1.1\nHost: old.test\n\n');
    setFuzzerWorkspace({ tabs: [draft], activeId: draft.id });
    render(<FuzzerTab />);
    fireEvent.change(templateBox(), { target: { value: 'GET /unsaved HTTP/1.1\nHost: old.test\n\n' } });

    setFuzzerWorkspace({ tabs: [{ ...draft, url: 'http://imported.test', template: 'GET /imported HTTP/1.1\nHost: imported.test\n\n' }], activeId: draft.id });

    await waitFor(() => expect(templateBox().value).toContain('/imported'));
    expect(screen.getByLabelText(t('fuzzer.targetUrl'))).toHaveProperty('value', 'http://imported.test');
  });

  it('ignores result events belonging to other runs', async () => {
    render(<FuzzerTab />);
    await userEvent.click(screen.getByRole('button', { name: t('fuzzer.start') }));
    await screen.findByText('letmein');
    const reads = () => vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes('/api/fuzzer/runs/atk1')).length;
    const before = reads();
    for (const socket of MockSocket.instances) socket.onmessage?.({ data: JSON.stringify({
      type: 'fuzzer.result', data: { run_id: 'another-run', result: results[0] },
    }) });
    expect(reads()).toBe(before);
  });

  it('keeps the newest run response when older refreshes finish later', async () => {
    render(<FuzzerTab />);
    await userEvent.click(screen.getByRole('button', { name: t('fuzzer.start') }));
    await screen.findByText('letmein');
    const originalFetch = fetch;
    const pending: Array<(response: Response) => void> = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/api/fuzzer/runs/atk1')) {
        return new Promise<Response>((resolve) => pending.push(resolve));
      }
      return originalFetch(input, init);
    }));
    const event = JSON.stringify({ type: 'fuzzer.result', data: { run_id: 'atk1', result: results[0] } });
    for (const socket of MockSocket.instances) socket.onmessage?.({ data: event });
    for (const socket of MockSocket.instances) socket.onmessage?.({ data: event });
    expect(pending).toHaveLength(2);
    const run = (payload: string) => ({
      id: 'atk1', mode: 'single_position', url: 'http://app.test',
      status: 'completed', total: 1, completed: 1, started_at: 1,
      finished_at: 2, error: null, template: 'GET / HTTP/1.1\n\n',
      payload_sets: [[payload]], speed: { concurrency: 5, delay: 0 },
      results: [{ ...results[0], payloads: [payload] }],
    });
    pending[1](jsonResponse(run('fresh')));
    await screen.findByText('fresh');
    pending[0](jsonResponse(run('stale')));
    await Promise.resolve();
    expect(screen.getByText('fresh')).toBeTruthy();
    expect(screen.queryByText('stale')).toBeNull();
  });

  it('refreshes history again when an event arrives during a list request', async () => {
    const originalFetch = fetch;
    let finishFirst!: (response: Response) => void;
    let lists = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/api/fuzzer/runs') && init?.method !== 'POST') {
        lists += 1;
        if (lists === 1) return new Promise<Response>((resolve) => { finishFirst = resolve; });
        return Promise.resolve(jsonResponse({ items: [{
          id: 'fresh', mode: 'single_position', url: 'http://fresh.test',
          status: 'running', total: 2, completed: 1, started_at: 2,
          finished_at: null, error: null,
        }] }));
      }
      return originalFetch(input, init);
    }));
    render(<FuzzerTab />);
    await Promise.resolve(); // socket open asks for a refresh during the first GET
    finishFirst(jsonResponse({ items: [] }));
    expect(await screen.findByRole('option', { name: /fresh\.test/ })).toBeTruthy();
    expect(lists).toBe(2);
  });

  it('has separate keyboard-operable select and close buttons', async () => {
    sendToFuzzer(flow);
    render(<FuzzerTab />);
    const close = screen.getByRole('button', { name: `${t('fuzzer.closeTab')} 1` });
    close.focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.queryByRole('button', { name: /app\.test/ })).toBeNull();
  });
  it('renames a request tab by double-clicking its title', async () => {
    const user = userEvent.setup();
    sendToFuzzer(flow);
    render(<FuzzerTab />);

    await user.dblClick(screen.getByText('1. http://app.test'));
    const name = screen.getByRole('textbox', {
      name: t('common.renameTab', { title: '1. http://app.test' }),
    });
    await user.clear(name);
    await user.type(name, 'Login fuzz{Enter}');

    expect(screen.getByText('Login fuzz')).toBeTruthy();
    expect(getFuzzerWorkspace().tabs[0].title).toBe('Login fuzz');
  });
  it('reorders request tabs by dragging without changing the active tab', async () => {
    const one = {
      ...newFuzzerDraft('http://one.test', 'GET /one HTTP/1.1\nHost: one.test\n\n'),
      title: 'One',
    };
    const two = {
      ...newFuzzerDraft('http://two.test', 'GET /two HTTP/1.1\nHost: two.test\n\n'),
      title: 'Two',
    };
    const three = {
      ...newFuzzerDraft('http://three.test', 'GET /three HTTP/1.1\nHost: three.test\n\n'),
      title: 'Three',
    };
    setFuzzerWorkspace({ tabs: [one, two, three], activeId: two.id });
    render(<FuzzerTab />);
    await waitFor(() => expect(templateBox().value).toContain('/two'));

    const source = screen.getByRole('button', { name: 'One' });
    const target = screen.getByRole('button', { name: 'Three' })
      .closest<HTMLDivElement>('.fuzzer-tab-choice')!;
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      width: 100,
    } as DOMRect);
    const transfer = {
      dropEffect: 'none',
      effectAllowed: 'none',
      setData: vi.fn(),
      getData: vi.fn(),
    } as unknown as DataTransfer;

    fireEvent.dragStart(source, { dataTransfer: transfer });
    await waitFor(() => expect(source.getAttribute('aria-grabbed')).toBe('true'));
    fireEvent.dragOver(target, { dataTransfer: transfer, clientX: 90 });
    await waitFor(() => expect(target.className).toContain('drop-after'));
    fireEvent.drop(target, { dataTransfer: transfer, clientX: 90 });

    await waitFor(() => expect(getFuzzerWorkspace().tabs.map((tab) => tab.id)).toEqual([
      two.id,
      three.id,
      one.id,
    ]));
    expect(getFuzzerWorkspace().activeId).toBe(two.id);
    expect(templateBox().value).toContain('/two');
    expect(document.querySelector('.fuzzer-tab-choice.active .tab-title')?.textContent)
      .toBe('Two');
  });
  it('keeps an edited target when its hidden tab is shown again', async () => {
    sendToFuzzer(flow);
    function Harness() {
      const [visible, setVisible] = useState(true);
      return <>
        <button onClick={() => setVisible((current) => !current)}>switch tab</button>
        <Activity mode={visible ? 'visible' : 'hidden'}><FuzzerTab /></Activity>
      </>;
    }
    render(<Harness />);
    await waitFor(() => expect(templateBox().value).toContain('/login'));
    fireEvent.change(templateBox(), { target: { value: 'GET /edited HTTP/1.1\nHost: app.test\n\n' } });

    await userEvent.click(screen.getByRole('button', { name: 'switch tab' }));
    await userEvent.click(screen.getByRole('button', { name: 'switch tab' }));
    expect(templateBox().value).toContain('/edited');
  });

  it('shows the position and request estimate', () => {
    render(<FuzzerTab />);
    expect(screen.getByText(t('fuzzer.positions', { count: 1, requests: 3 }))).toBeTruthy();
  });

  it('updates the estimate when payloads change', async () => {
    const user = userEvent.setup();
    render(<FuzzerTab />);
    await user.clear(screen.getByLabelText(t('fuzzer.payloadSet', { index: 1 })));
    await user.type(screen.getByLabelText(t('fuzzer.payloadSet', { index: 1 })), 'a\nb');
    await waitFor(() => expect(screen.getByText(t('fuzzer.positions', { count: 1, requests: 2 }))).toBeTruthy());
  });

  it('adds and clears payload markers', async () => {
    const user = userEvent.setup();
    render(<FuzzerTab />);
    await user.click(screen.getByRole('button', { name: t('fuzzer.clearMarkers') }));
    await waitFor(() => expect(screen.getByText(t('fuzzer.positions', { count: 0, requests: 0 }))).toBeTruthy());
    expect(templateBox().value).not.toContain('{{');
    expect(templateBox().value).not.toContain('}}');
  });

  it('marks the selected text', async () => {
    const user = userEvent.setup();
    render(<FuzzerTab />);
    await user.click(screen.getByRole('button', { name: t('fuzzer.clearMarkers') }));
    await user.clear(templateBox());
    await user.type(templateBox(), 'GET /?q=abc HTTP/1.1');

    const editor = templateBox();
    editor.setSelectionRange(8, 11);
    document.dispatchEvent(new Event('selectionchange'));
    await user.click(screen.getByRole('button', { name: t('fuzzer.addMarker') }));

    expect(templateBox().value).toBe('GET /?q={{abc}} HTTP/1.1');
  });

  it('still marks when the selection is lost on the way to the button', async () => {
    // Pressing a button moves focus, and a webview can collapse the
    // textarea's selection before the handler runs. Without remembering
    // it, the button silently did nothing.
    const user = userEvent.setup();
    render(<FuzzerTab />);
    await user.click(screen.getByRole('button', { name: t('fuzzer.clearMarkers') }));
    await user.clear(templateBox());
    await user.type(templateBox(), 'GET /?q=abc HTTP/1.1');

    const editor = templateBox();
    editor.setSelectionRange(8, 11);
    document.dispatchEvent(new Event('selectionchange'));
    // The selection is gone by the time the click lands.
    editor.setSelectionRange(0, 0);

    await user.click(screen.getByRole('button', { name: t('fuzzer.addMarker') }));
    expect(templateBox().value).toBe('GET /?q={{abc}} HTTP/1.1');
  });

  it('warns about unbalanced markers', async () => {
    render(<FuzzerTab />);
    fireEvent.change(templateBox(), { target: { value: 'GET /?a={{x HTTP/1.1' } });
    expect(await screen.findByText(t('intercept.unbalancedMarker'))).toBeTruthy();
  });

  it('grows payload set inputs for Cartesian product mode', async () => {
    const user = userEvent.setup();
    render(<FuzzerTab />);
    fireEvent.change(templateBox(), {
      target: { value: 'GET /?u={{a}}&p={{b}} HTTP/1.1' },
    });
    await user.selectOptions(
      screen.getByLabelText(t('fuzzer.mode')),
      'cartesian',
    );
    expect(await screen.findByLabelText(t('fuzzer.payloadSet', { index: 2 }))).toBeTruthy();
  });

  it('starts a run and renders results', async () => {
    const user = userEvent.setup();
    render(<FuzzerTab />);
    await user.click(screen.getByRole('button', { name: t('fuzzer.start') }));

    expect(await screen.findByText('letmein')).toBeTruthy();
    expect(started[0].payload_sets).toEqual([['a', 'b', 'c']]);
    expect(screen.getAllByText(/completed · 3\/3/).length).toBeGreaterThan(0);
    await user.click(screen.getByText('letmein').closest('tr')!);
    await waitFor(() => expect(document.querySelector('.replay-response .hljs-number')?.textContent).toBe('403'));
  });

  it('highlights the response whose length stands out', async () => {
    const user = userEvent.setup();
    render(<FuzzerTab />);
    await user.click(screen.getByRole('button', { name: t('fuzzer.start') }));
    await screen.findByText('letmein');

    const row = screen.getByText('letmein').closest('tr');
    expect(row?.className).toContain('outlier');
    expect(
      screen.getByText('wrong').closest('tr')?.className ?? '',
    ).not.toContain('outlier');
  });

  it('picks up a request sent from the Proxy tab', async () => {
    render(<FuzzerTab />);
    sendToFuzzer(flow);
    await waitFor(() =>
      expect(templateBox().value).toContain('GET /login?pw=guess'),
    );
    expect(screen.getAllByLabelText(t('fuzzer.targetUrl')).at(-1)).toHaveProperty(
      'value',
      'http://app.test',
    );
  });

  it('keeps an active run when another request is sent to Fuzzer', async () => {
    status = 'running';
    sendToFuzzer(flow);
    render(<FuzzerTab />);
    await userEvent.click(screen.getByRole('button', { name: t('fuzzer.start') }));
    expect(await screen.findByRole('button', { name: t('fuzzer.stop') })).toBeTruthy();

    sendToFuzzer({ ...flow, id: 'f2', host: 'other.test', path: '/second' });
    await waitFor(() => expect(templateBox().value).toContain('/second'));
    expect(screen.getByRole('button', { name: t('fuzzer.start') })).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: /app\.test/ }));
    expect(await screen.findByRole('button', { name: t('fuzzer.stop') })).toBeTruthy();
    expect(templateBox().value).toContain('/login');
  });

  it('opens a saved run from history after the editor was reset', async () => {
    render(<FuzzerTab />);
    await userEvent.selectOptions(await screen.findByLabelText(t('fuzzer.history')), 'atk1');
    await waitFor(() => expect(templateBox().value).toContain('/saved'));
    await waitFor(() => expect(screen.getAllByText(/completed · 3\/3/).length).toBeGreaterThan(1));
  });

  it('offers a stop button while a run is active', async () => {
    status = 'running';
    const user = userEvent.setup();
    render(<FuzzerTab />);
    await user.click(screen.getByRole('button', { name: t('fuzzer.start') }));
    expect(await screen.findByRole('button', { name: t('fuzzer.stop') })).toBeTruthy();
  });
});

describe('result context menu', () => {
  it('sends the selected result to Replay with the configured shortcut', async () => {
    render(<FuzzerTab />);
    await userEvent.click(screen.getByRole('button', { name: t('fuzzer.start') }));
    const row = (await screen.findByText('letmein')).closest('tr')!;
    fireEvent.click(row);
    fireShortcut('request.sendToReplay', row);
    await waitFor(() => expect(getTabs()).toHaveLength(1));
    expect(getTabs()[0].text).toContain('captured-request-r1');
    expect(started).toHaveLength(1);
  });

  it('offers to resend a result, which is the point of finding one', async () => {
    render(<FuzzerTab />);
    await userEvent.click(screen.getByRole('button', { name: t('fuzzer.start') }));
    const row = await screen.findByText('letmein');

    fireEvent.contextMenu(row.closest('tr')!);

    expect(
      screen.getByRole('menuitem', { name: t('menu.sendToReplay') }),
    ).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: t('menu.scopeIncludeRule') })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: t('menu.copyPayload') })).toBeTruthy();
  });

  it('adds a result path to Scope from its captured request', async () => {
    const user = userEvent.setup();
    render(<FuzzerTab />);
    await user.click(screen.getByRole('button', { name: t('fuzzer.start') }));
    fireEvent.contextMenu((await screen.findByText('letmein')).closest('tr')!);
    await user.hover(screen.getByRole('menuitem', { name: t('menu.scopeIncludeRule') }));
    fireEvent.click(await screen.findByRole('menuitem', { name: t('menu.scopePath') }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input, init]) =>
      String(input).endsWith('/api/scope/rules') &&
      JSON.parse(String(init?.body)).path === '/login*' &&
      JSON.parse(String(init?.body)).kind === 'include'
    )).toBe(true));
  });

  it('cannot resend a result that has no request behind it', async () => {
    results = [
      {
        index: 0,
        payloads: ['x'],
        status_code: null,
        length: 0,
        duration_ms: null,
        error: 'timeout',
        flow_id: null,
      },
    ];
    render(<FuzzerTab />);
    await userEvent.click(screen.getByRole('button', { name: t('fuzzer.start') }));
    const row = await screen.findByText('x');

    fireEvent.contextMenu(row.closest('tr')!);

    expect(
      (screen.getByRole('menuitem', {
        name: t('menu.sendToReplay'),
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});


it('persists the HTTP mode in the Fuzzer draft and sends it in the run configuration', async () => {
  render(<FuzzerTab />);
  const select = await screen.findByRole('combobox', { name: t('httpProtocol.section') });
  fireEvent.change(select, { target: { value: 'http2' } });
  await waitFor(() => expect(getFuzzerWorkspace().tabs[0].httpMode).toBe('http2'));
  fireEvent.click(screen.getByRole('button', { name: t('fuzzer.start') }));
  await waitFor(() => expect(started).toHaveLength(1));
  expect(started[0]).toMatchObject({ http_mode: 'http2' });
});

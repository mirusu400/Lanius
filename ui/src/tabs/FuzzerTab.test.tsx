/** Renders the real Fuzzer tab against a mocked engine. */
import { Activity, useState } from 'react';
import {cleanup, screen, waitFor, fireEvent } from '@testing-library/react';
import { renderWithI18n as render, t } from '../test-utils';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FuzzerTab } from './FuzzerTab';
import { resetTarget, sendToFuzzer } from './fuzzerStore';
import type { RunResult, FlowSummary } from '../api/types';

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
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;
  constructor(url: string) {
    this.url = url;
    queueMicrotask(() => this.onopen?.());
  }
  close() {}
}

beforeEach(() => {
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

const templateBox = () =>
  screen.getByRole('textbox', { name: t('fuzzer.templateLabel') }) as HTMLTextAreaElement;

describe('FuzzerTab', () => {
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
    expect(screen.getByText(/completed · 3\/3/)).toBeTruthy();
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
    expect(screen.getByLabelText(t('fuzzer.targetUrl'))).toHaveProperty(
      'value',
      'http://app.test',
    );
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
  it('offers to resend a result, which is the point of finding one', async () => {
    render(<FuzzerTab />);
    await userEvent.click(screen.getByRole('button', { name: t('fuzzer.start') }));
    const row = await screen.findByText('letmein');

    fireEvent.contextMenu(row.closest('tr')!);

    expect(
      screen.getByRole('menuitem', { name: t('menu.sendToReplay') }),
    ).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: t('menu.copyPayload') })).toBeTruthy();
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

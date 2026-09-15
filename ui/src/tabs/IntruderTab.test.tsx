/** Renders the real Intruder tab against a mocked engine. */
import {cleanup, screen, waitFor, fireEvent } from '@testing-library/react';
import { renderWithI18n as render, t } from '../test-utils';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IntruderTab } from './IntruderTab';
import { resetTarget, sendToIntruder } from './intruderStore';
import type { AttackResult, FlowSummary } from '../api/types';

let started: { url: string; attack_type: string; payload_sets: string[][] }[] =
  [];
let results: AttackResult[] = [];
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
      if (url.endsWith('/api/intruder/attacks') && init?.method === 'POST') {
        started.push(body);
        return jsonResponse({
          id: 'atk1',
          attack_type: body.attack_type,
          url: body.url,
          status,
          total: results.length,
          completed: 0,
          started_at: 1,
          finished_at: null,
          error: null,
        });
      }
      if (url.includes('/api/intruder/attacks/atk1')) {
        return jsonResponse({
          id: 'atk1',
          attack_type: 'sniper',
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
  screen.getByRole('textbox', { name: t('intruder.templateLabel') }) as HTMLTextAreaElement;

describe('IntruderTab', () => {
  it('shows the position and request estimate', () => {
    render(<IntruderTab />);
    expect(screen.getByText(t('intruder.positions', { count: 1, requests: 3 }))).toBeTruthy();
  });

  it('updates the estimate when payloads change', async () => {
    const user = userEvent.setup();
    render(<IntruderTab />);
    await user.clear(screen.getByLabelText(t('intruder.payloadSet', { index: 1 })));
    await user.type(screen.getByLabelText(t('intruder.payloadSet', { index: 1 })), 'a\nb');
    await waitFor(() => expect(screen.getByText(t('intruder.positions', { count: 1, requests: 2 }))).toBeTruthy());
  });

  it('adds and clears payload markers', async () => {
    const user = userEvent.setup();
    render(<IntruderTab />);
    await user.click(screen.getByRole('button', { name: t('intruder.clearMarkers') }));
    await waitFor(() => expect(screen.getByText(t('intruder.positions', { count: 0, requests: 0 }))).toBeTruthy());
    expect(templateBox().value).not.toContain('\u00a7');
  });

  it('marks the selected text', async () => {
    const user = userEvent.setup();
    render(<IntruderTab />);
    await user.click(screen.getByRole('button', { name: t('intruder.clearMarkers') }));
    await user.clear(templateBox());
    await user.type(templateBox(), 'GET /?q=abc HTTP/1.1');

    const editor = templateBox();
    editor.setSelectionRange(8, 11);
    document.dispatchEvent(new Event('selectionchange'));
    await user.click(screen.getByRole('button', { name: t('intruder.addMarker') }));

    expect(templateBox().value).toBe('GET /?q=\u00a7abc\u00a7 HTTP/1.1');
  });

  it('still marks when the selection is lost on the way to the button', async () => {
    // Pressing a button moves focus, and a webview can collapse the
    // textarea's selection before the handler runs. Without remembering
    // it, the button silently did nothing.
    const user = userEvent.setup();
    render(<IntruderTab />);
    await user.click(screen.getByRole('button', { name: t('intruder.clearMarkers') }));
    await user.clear(templateBox());
    await user.type(templateBox(), 'GET /?q=abc HTTP/1.1');

    const editor = templateBox();
    editor.setSelectionRange(8, 11);
    document.dispatchEvent(new Event('selectionchange'));
    // The selection is gone by the time the click lands.
    editor.setSelectionRange(0, 0);

    await user.click(screen.getByRole('button', { name: t('intruder.addMarker') }));
    expect(templateBox().value).toBe('GET /?q=\u00a7abc\u00a7 HTTP/1.1');
  });

  it('warns about unbalanced markers', async () => {
    const user = userEvent.setup();
    render(<IntruderTab />);
    await user.clear(templateBox());
    await user.type(templateBox(), 'GET /?a=\u00a7x HTTP/1.1');
    expect(await screen.findByText(t('intercept.unbalancedMarker'))).toBeTruthy();
  });

  it('grows payload set inputs for cluster bomb', async () => {
    const user = userEvent.setup();
    render(<IntruderTab />);
    await user.clear(templateBox());
    await user.type(
      templateBox(),
      'GET /?u=\u00a7a\u00a7&p=\u00a7b\u00a7 HTTP/1.1',
    );
    await user.selectOptions(
      screen.getByLabelText(t('intruder.attackType')),
      'cluster_bomb',
    );
    expect(await screen.findByLabelText(t('intruder.payloadSet', { index: 2 }))).toBeTruthy();
  });

  it('starts an attack and renders results', async () => {
    const user = userEvent.setup();
    render(<IntruderTab />);
    await user.click(screen.getByRole('button', { name: t('intruder.start') }));

    expect(await screen.findByText('letmein')).toBeTruthy();
    expect(started[0].payload_sets).toEqual([['a', 'b', 'c']]);
    expect(screen.getByText(/completed · 3\/3/)).toBeTruthy();
  });

  it('highlights the response whose length stands out', async () => {
    const user = userEvent.setup();
    render(<IntruderTab />);
    await user.click(screen.getByRole('button', { name: t('intruder.start') }));
    await screen.findByText('letmein');

    const row = screen.getByText('letmein').closest('tr');
    expect(row?.className).toContain('outlier');
    expect(
      screen.getByText('wrong').closest('tr')?.className ?? '',
    ).not.toContain('outlier');
  });

  it('picks up a request sent from the Proxy tab', async () => {
    render(<IntruderTab />);
    sendToIntruder(flow);
    await waitFor(() =>
      expect(templateBox().value).toContain('GET /login?pw=guess'),
    );
    expect(screen.getByLabelText(t('intruder.targetUrl'))).toHaveProperty(
      'value',
      'http://app.test',
    );
  });

  it('offers a stop button while an attack runs', async () => {
    status = 'running';
    const user = userEvent.setup();
    render(<IntruderTab />);
    await user.click(screen.getByRole('button', { name: t('intruder.start') }));
    expect(await screen.findByRole('button', { name: t('intruder.stop') })).toBeTruthy();
  });
});

describe('result context menu', () => {
  it('offers to resend a result, which is the point of finding one', async () => {
    render(<IntruderTab />);
    await userEvent.click(screen.getByRole('button', { name: t('intruder.start') }));
    const row = await screen.findByText('letmein');

    fireEvent.contextMenu(row.closest('tr')!);

    expect(
      screen.getByRole('menuitem', { name: t('menu.sendToRepeater') }),
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
    render(<IntruderTab />);
    await userEvent.click(screen.getByRole('button', { name: t('intruder.start') }));
    const row = await screen.findByText('x');

    fireEvent.contextMenu(row.closest('tr')!);

    expect(
      (screen.getByRole('menuitem', {
        name: t('menu.sendToRepeater'),
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

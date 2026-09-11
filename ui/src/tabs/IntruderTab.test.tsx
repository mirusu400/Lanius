/** Renders the real Intruder tab against a mocked engine. */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
  constructor(public url: string) {
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
  screen.getByRole('textbox', { name: 'request template' }) as HTMLTextAreaElement;

describe('IntruderTab', () => {
  it('shows the position and request estimate', () => {
    render(<IntruderTab />);
    expect(screen.getByText(/위치 1 · 요청 3건/)).toBeTruthy();
  });

  it('updates the estimate when payloads change', async () => {
    const user = userEvent.setup();
    render(<IntruderTab />);
    await user.clear(screen.getByLabelText('payload set 1'));
    await user.type(screen.getByLabelText('payload set 1'), 'a\nb');
    await waitFor(() => expect(screen.getByText(/요청 2건/)).toBeTruthy());
  });

  it('adds and clears payload markers', async () => {
    const user = userEvent.setup();
    render(<IntruderTab />);
    await user.click(screen.getByRole('button', { name: 'Clear §' }));
    await waitFor(() => expect(screen.getByText(/위치 0/)).toBeTruthy());
    expect(templateBox().value).not.toContain('\u00a7');
  });

  it('warns about unbalanced markers', async () => {
    const user = userEvent.setup();
    render(<IntruderTab />);
    await user.clear(templateBox());
    await user.type(templateBox(), 'GET /?a=\u00a7x HTTP/1.1');
    expect(await screen.findByText(/마커 개수가 맞지 않습니다/)).toBeTruthy();
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
      screen.getByLabelText('attack type'),
      'cluster_bomb',
    );
    expect(await screen.findByLabelText('payload set 2')).toBeTruthy();
  });

  it('starts an attack and renders results', async () => {
    const user = userEvent.setup();
    render(<IntruderTab />);
    await user.click(screen.getByRole('button', { name: 'Start attack' }));

    expect(await screen.findByText('letmein')).toBeTruthy();
    expect(started[0].payload_sets).toEqual([['a', 'b', 'c']]);
    expect(screen.getByText(/completed · 3\/3/)).toBeTruthy();
  });

  it('highlights the response whose length stands out', async () => {
    const user = userEvent.setup();
    render(<IntruderTab />);
    await user.click(screen.getByRole('button', { name: 'Start attack' }));
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
    expect(screen.getByLabelText('target url')).toHaveProperty(
      'value',
      'http://app.test',
    );
  });

  it('offers a stop button while an attack runs', async () => {
    status = 'running';
    const user = userEvent.setup();
    render(<IntruderTab />);
    await user.click(screen.getByRole('button', { name: 'Start attack' }));
    expect(await screen.findByRole('button', { name: 'Stop' })).toBeTruthy();
  });
});

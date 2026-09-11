/**
 * Renders the real ProxyTab against a mocked engine (fetch + WebSocket) and
 * asserts the live history table and detail pane behave as expected.
 */
import {cleanup, screen, waitFor } from '@testing-library/react';
import { renderWithI18n as render, t } from '../test-utils';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProxyTab } from './ProxyTab';
import type { FlowSummary } from '../api/types';

const seeded: FlowSummary = {
  id: 'seed-1',
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

beforeEach(() => {
  MockSocket.instances = [];
  vi.stubGlobal('WebSocket', MockSocket as unknown as typeof WebSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
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
  it('loads existing history from REST on mount', async () => {
    render(<ProxyTab />);
    expect(await screen.findByText('seeded.test')).toBeTruthy();
    expect(screen.getByText('/seeded')).toBeTruthy();
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

  it('shows connection state and flow count', async () => {
    render(<ProxyTab />);
    await waitFor(() => expect(screen.getByText(t('proxy.live'))).toBeTruthy());
    expect(screen.getByText(t('proxy.flowCount', { count: 1 }))).toBeTruthy();
  });

  it('shows request/response detail when a row is selected', async () => {
    const user = userEvent.setup();
    render(<ProxyTab />);
    await user.click(await screen.findByText('/seeded'));

    expect(await screen.findByText('<redacted>')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: new RegExp(t('detail.response')) }));
    expect(await screen.findByText('<h1>hello lanius</h1>')).toBeTruthy();
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

  it('clears the table on flows.cleared', async () => {
    render(<ProxyTab />);
    await screen.findByText('seeded.test');
    MockSocket.instances[0].emit('flows.cleared', {});
    await waitFor(() => expect(screen.queryByText('seeded.test')).toBeNull());
  });
});

/** Logger + Settings tabs against a mocked engine. */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LoggerTab } from './LoggerTab';
import { SettingsTab } from './SettingsTab';

class MockSocket {
  static last: MockSocket | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;
  constructor(url: string) {
    this.url = url;
    MockSocket.last = this;
    queueMicrotask(() => this.onopen?.());
  }
  emit(type: string, data: unknown) {
    this.onmessage?.({ data: JSON.stringify({ type, data }) });
  }
  close() {}
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body } as Response;
}

beforeEach(() => {
  MockSocket.last = null;
  vi.stubGlobal('WebSocket', MockSocket as unknown as typeof WebSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/events')) {
        return jsonResponse({
          items: [
            { id: 2, ts: 1700000000, level: 'info', message: 'scope.changed {}' },
            { id: 1, ts: 1699999999, level: 'info', message: 'engine.started {}' },
          ],
        });
      }
      if (url.includes('/api/ca')) {
        return jsonResponse({
          confdir: '/home/u/.mitmproxy',
          available: { pem: true, cer: true, p12: false },
          install_url: 'http://mitm.it',
          proxy: '127.0.0.1:8080',
        });
      }
      if (url.includes('/api/status')) {
        return jsonResponse({
          version: '0.1.0',
          proxy: { running: true, host: '127.0.0.1', port: 8080 },
          flows: 42,
          subscribers: 1,
          db_path: '/home/u/.lanius/lanius.sqlite',
          intercept: {
            enabled: false,
            intercept_requests: true,
            intercept_responses: false,
            host_filter: null,
          },
          paused: 0,
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

describe('LoggerTab', () => {
  it('shows stored events from the engine', async () => {
    render(<LoggerTab />);
    expect(await screen.findByText(/engine.started/)).toBeTruthy();
    expect(screen.getByText(/scope.changed/)).toBeTruthy();
  });

  it('appends live events from the websocket', async () => {
    render(<LoggerTab />);
    await waitFor(() => expect(MockSocket.last).toBeTruthy());
    MockSocket.last!.emit('flow.request', { id: 'abc' });
    expect(await screen.findByText('flow.request')).toBeTruthy();
  });

  it('filters live events', async () => {
    const user = userEvent.setup();
    render(<LoggerTab />);
    await waitFor(() => expect(MockSocket.last).toBeTruthy());
    MockSocket.last!.emit('flow.request', { id: 'abc' });
    MockSocket.last!.emit('intercept.paused', { id: 'zzz' });
    await screen.findByText('flow.request');

    await user.type(screen.getByLabelText('log filter'), 'intercept');
    await waitFor(() => expect(screen.queryByText('flow.request')).toBeNull());
    expect(screen.getByText('intercept.paused')).toBeTruthy();
  });

  it('pauses and clears the live feed', async () => {
    const user = userEvent.setup();
    render(<LoggerTab />);
    await waitFor(() => expect(MockSocket.last).toBeTruthy());
    MockSocket.last!.emit('flow.request', { id: 'a' });
    await screen.findByText('flow.request');

    await user.click(screen.getByRole('button', { name: /일시정지/ }));
    MockSocket.last!.emit('flow.response', { id: 'b' });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('flow.response')).toBeNull();

    await user.click(screen.getByRole('button', { name: '지우기' }));
    await waitFor(() => expect(screen.queryByText('flow.request')).toBeNull());
  });
});

describe('SettingsTab', () => {
  it('shows engine and proxy status', async () => {
    render(<SettingsTab />);
    expect(await screen.findByText('running')).toBeTruthy();
    // shown in both the proxy section and the CA section
    expect(screen.getAllByText('127.0.0.1:8080').length).toBeGreaterThan(0);
    expect(screen.getByText('42')).toBeTruthy();
  });

  it('offers CA downloads for available formats only', async () => {
    render(<SettingsTab />);
    const pem = (await screen.findByText('.pem 내려받기')) as HTMLAnchorElement;
    expect(pem.getAttribute('href')).toContain('/api/ca/pem');
    const p12 = screen.getByText('.p12 내려받기');
    expect(p12.className).toContain('disabled');
    expect(p12.getAttribute('href')).toBeNull();
  });

  it('links to mitm.it for device installation', async () => {
    render(<SettingsTab />);
    const link = (await screen.findByText('mitm.it')) as HTMLAnchorElement;
    expect(link.href).toContain('mitm.it');
  });

  it('shows the CA directory', async () => {
    render(<SettingsTab />);
    expect(await screen.findByText('/home/u/.mitmproxy')).toBeTruthy();
  });
});

/** Logger + Settings tabs against a mocked engine. */
import {cleanup, screen, waitFor } from '@testing-library/react';
import { renderWithI18n as render, t } from '../test-utils';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LoggerTab } from './LoggerTab';
import { CaSection } from './settings/CaSection';
import { EngineSection } from './settings/EngineSection';
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
  // Settings remembers the group you were in, so one test choosing a
  // group would otherwise decide where the next one starts.
  window.localStorage.clear();
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

    await user.type(screen.getByLabelText(t('logger.filter')), 'intercept');
    await waitFor(() => expect(screen.queryByText('flow.request')).toBeNull());
    expect(screen.getByText('intercept.paused')).toBeTruthy();
  });

  it('pauses and clears the live feed', async () => {
    const user = userEvent.setup();
    render(<LoggerTab />);
    await waitFor(() => expect(MockSocket.last).toBeTruthy());
    MockSocket.last!.emit('flow.request', { id: 'a' });
    await screen.findByText('flow.request');

    await user.click(screen.getByRole('button', { name: t('common.pause') }));
    MockSocket.last!.emit('flow.response', { id: 'b' });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('flow.response')).toBeNull();

    await user.click(screen.getByRole('button', { name: t('common.clear') }));
    await waitFor(() => expect(screen.queryByText('flow.request')).toBeNull());
  });
});

describe('SettingsTab', () => {
  it('shows engine and proxy status', async () => {
    render(<EngineSection />);
    expect(await screen.findByText(t('settings.running'))).toBeTruthy();
    expect(screen.getByText('127.0.0.1:8080')).toBeTruthy();
    expect(screen.getByText('42')).toBeTruthy();
  });

  it('opens on the proxy group, where the listener lives', async () => {
    // The group people come here for most often, and the one that
    // explains why nothing is being captured.
    render(<SettingsTab />);
    const proxy = await screen.findByRole('button', {
      name: t('settings.group.proxy'),
    });
    expect(proxy.className).toContain('active');
  });

  it('remembers the group you were last in', async () => {
    const user = userEvent.setup();
    const view = render(<SettingsTab />);
    await user.click(screen.getByRole('button', { name: t('settings.group.project') }));
    view.unmount();
    render(<SettingsTab />);
    const project = await screen.findByRole('button', {
      name: t('settings.group.project'),
    });
    expect(project.className).toContain('active');
  });

  it('shows one group at a time', async () => {
    // The whole point: eleven sections on one page meant scrolling past
    // everything else to reach any one of them.
    render(<SettingsTab />);
    await screen.findByRole('button', { name: t('settings.group.proxy') });
    // Headings, not the group buttons: a group label and its section
    // heading can read the same.
    const headings = () =>
      [...document.querySelectorAll('h3')].map((h) => h.textContent);
    expect(headings()).toContain(t('listener.section'));
    expect(headings()).not.toContain(t('mcp.section'));
    expect(headings()).not.toContain(t('project.section'));
  });

  it('offers CA downloads for available formats only', async () => {
    render(<CaSection />);
    const pem = (await screen.findByText(t('settings.caDownload', { format: 'pem' }))) as HTMLAnchorElement;
    expect(pem.getAttribute('href')).toContain('/api/ca/pem');
    const p12 = screen.getByText(t('settings.caDownload', { format: 'p12' }));
    expect(p12.className).toContain('disabled');
    expect(p12.getAttribute('href')).toBeNull();
  });

  it('links to mitm.it for device installation', async () => {
    render(<CaSection />);
    const link = (await screen.findByText('mitm.it')) as HTMLAnchorElement;
    expect(link.href).toContain('mitm.it');
  });

  it('shows the CA directory', async () => {
    render(<CaSection />);
    expect(await screen.findByText('/home/u/.mitmproxy')).toBeTruthy();
  });
});

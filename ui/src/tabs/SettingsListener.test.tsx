/** The proxy listener controls in Settings.
 *
 * These exist because a port held by another tool used to leave the app
 * unusable with no way out from inside it.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ListenerSection } from './settings/ListenerSection';
import { renderWithI18n as render, t } from '../test-utils';

let listener = {
  host: '127.0.0.1',
  port: 8080,
  running: true,
  error: null as string | null,
  exposed: false,
  addresses: [
    { host: '127.0.0.1', label: 'This machine only' },
    { host: '0.0.0.0', label: 'All interfaces' },
    { host: '192.168.1.42', label: '192.168.1.42' },
  ],
};

let posted: { host: string; port: number }[] = [];
let rejectWith: string | null = null;

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers({ 'Content-Type': 'application/json' }),
  } as unknown as Response;
}

beforeEach(() => {
  listener = {
    host: '127.0.0.1',
    port: 8080,
    running: true,
    error: null,
    exposed: false,
    addresses: [
      { host: '127.0.0.1', label: 'This machine only' },
      { host: '0.0.0.0', label: 'All interfaces' },
      { host: '192.168.1.42', label: '192.168.1.42' },
    ],
  };
  posted = [];
  rejectWith = null;

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/listener')) {
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as {
            host: string;
            port: number;
          };
          posted.push(body);
          if (rejectWith) {
            return jsonResponse({ detail: rejectWith }, 409);
          }
          listener = {
            ...listener,
            host: body.host,
            port: body.port,
            running: true,
            error: null,
            exposed: !body.host.startsWith('127.'),
          };
        }
        return jsonResponse(listener);
      }
      if (url.includes('/api/ca')) {
        return jsonResponse({ available: false });
      }
      if (url.includes('/api/tls')) {
        return jsonResponse({
          profile: 'default',
          custom_ciphers: null,
          ciphers: null,
          available: [{ id: 'default', label: 'mitmproxy default' }],
        });
      }
      if (url.includes('/api/capture/local')) {
        return jsonResponse({ supported: false, approved: false, detail: '' });
      }
      if (url.includes('/api/status')) {
        return jsonResponse({
          version: '0.1.0',
          proxy: {
            running: listener.running,
            host: listener.host,
            port: listener.port,
            error: listener.error,
          },
          flows: 0,
          subscribers: 0,
          db_path: '/tmp/x.sqlite',
          intercept: {
            enabled: false,
            intercept_requests: true,
            intercept_responses: false,
            host_filter: null,
          },
          paused: 0,
          modes: [],
          local_capture: { supported: false, approved: false, detail: '', spec: null },
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

const portInput = () =>
  screen.getByLabelText(t('listener.port')) as HTMLInputElement;
const bindSelect = () =>
  screen.getByLabelText(t('listener.bind')) as HTMLSelectElement;
/** Scoped to this section: the TLS section has an Apply button too. */
const applyButton = () => {
  const section = portInput().closest('section');
  if (!section) throw new Error('listener section not found');
  return within(section).getByRole('button', { name: t('listener.apply') });
};

describe('listener settings', () => {
  it('shows where the proxy is listening', async () => {
    render(<ListenerSection />);
    await waitFor(() => expect(portInput()).toBeTruthy());
    expect(portInput().value).toBe('8080');
    expect(bindSelect().value).toBe('127.0.0.1');
    expect(screen.getByText(t('listener.localOnly'))).toBeTruthy();
  });

  it('moves the proxy to another port', async () => {
    const user = userEvent.setup();
    render(<ListenerSection />);
    await waitFor(() => expect(portInput()).toBeTruthy());

    await user.clear(portInput());
    await user.type(portInput(), '8090');
    await user.click(applyButton());

    await waitFor(() => expect(posted).toEqual([{ host: '127.0.0.1', port: 8090 }]));
    expect(
      await screen.findByText(
        t('listener.applied', { host: '127.0.0.1', port: 8090 }),
      ),
    ).toBeTruthy();
  });

  it('warns before binding beyond this machine', async () => {
    const user = userEvent.setup();
    render(<ListenerSection />);
    await waitFor(() => expect(bindSelect()).toBeTruthy());

    // The warning appears on choosing, before anything is applied.
    await user.selectOptions(bindSelect(), '0.0.0.0');
    expect(screen.getByText(t('listener.exposed'))).toBeTruthy();
    expect(posted).toHaveLength(0);
  });

  it('offers the addresses this machine can bind', async () => {
    render(<ListenerSection />);
    await waitFor(() => expect(bindSelect()).toBeTruthy());
    const values = [...bindSelect().options].map((option) => option.value);
    expect(values).toContain('127.0.0.1');
    expect(values).toContain('0.0.0.0');
    // A LAN address, which is what a phone would be pointed at.
    expect(values).toContain('192.168.1.42');
  });

  it('says the proxy was kept when the new address is refused', async () => {
    const user = userEvent.setup();
    rejectWith = 'proxy port 127.0.0.1:9999 is unavailable: in use';
    render(<ListenerSection />);
    await waitFor(() => expect(portInput()).toBeTruthy());

    await user.clear(portInput());
    await user.type(portInput(), '9999');
    await user.click(applyButton());

    expect(await screen.findByText(t('listener.kept'))).toBeTruthy();
    // Still showing the address that is actually serving.
    await waitFor(() => expect(portInput().value).toBe('8080'));
  });

  it('explains a proxy that never started, and offers the way out', async () => {
    // The bug from the released build: the port was taken at launch.
    listener = {
      ...listener,
      running: false,
      error: 'proxy port 127.0.0.1:8080 is unavailable: address in use',
    };
    render(<ListenerSection />);

    expect(
      await screen.findByText(
        t('listener.down', { message: listener.error as string }),
        { exact: false },
      ),
    ).toBeTruthy();
    // The controls are present, so the user can fix it here.
    expect(portInput()).toBeTruthy();
  });
});

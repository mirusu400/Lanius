/** Opening a browser that is already set up for the proxy.
 *
 * The point is that a user does not have to configure anything, so the
 * tests check what the button offers and what it does when there is no
 * browser to open, rather than that a request was sent.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsTab } from './SettingsTab';
import { renderWithI18n as render, t } from '../test-utils';

let browserState: {
  available: boolean;
  name: string | null;
  profile: string;
  ca_trusted: boolean;
} = {
  available: true,
  name: 'Google Chrome',
  profile: '/home/u/.lanius/browser-profile',
  ca_trusted: true,
};
let launches = 0;
let launchError: string | null = null;
let cleared = 0;

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
  browserState = {
    available: true,
    name: 'Google Chrome',
    profile: '/home/u/.lanius/browser-profile',
    ca_trusted: true,
  };
  launches = 0;
  launchError = null;
  cleared = 0;

  vi.stubGlobal('confirm', () => true);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/browser/profile')) {
        cleared += 1;
        return jsonResponse({ cleared: true });
      }
      if (url.includes('/api/browser')) {
        if (init?.method === 'POST') {
          if (launchError) return jsonResponse({ detail: launchError }, 409);
          launches += 1;
          return jsonResponse({
            name: 'Google Chrome',
            path: '/fake/chrome',
            pid: 1234,
            profile: browserState.profile,
            proxy: 'http://127.0.0.1:8080',
            ca_trusted: true,
          });
        }
        return jsonResponse(browserState);
      }
      if (url.includes('/api/mcp')) {
        return jsonResponse({
          available: true,
          enabled: true,
          url: 'http://127.0.0.1:8081/mcp/mcp',
          host: '127.0.0.1',
          port: 8081,
          tools: [],
        });
      }
      if (url.includes('/api/listener')) {
        return jsonResponse({
          host: '127.0.0.1',
          port: 8080,
          running: true,
          error: null,
          exposed: false,
          addresses: [{ host: '127.0.0.1', label: 'This machine only' }],
        });
      }
      if (url.includes('/api/ca')) return jsonResponse({ available: false });
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
          proxy: { running: true, host: '127.0.0.1', port: 8080, error: null },
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

const section = () => {
  const heading = screen.getByText(t('browser.section'));
  const node = heading.closest('section');
  if (!node) throw new Error('browser section not found');
  return within(node);
};

describe('browser settings', () => {
  it('opens a browser through the proxy', async () => {
    const user = userEvent.setup();
    render(<SettingsTab />);
    await waitFor(() => expect(screen.getByText(t('browser.section'))).toBeTruthy());

    await user.click(section().getByRole('button', { name: t('browser.open') }));
    await waitFor(() => expect(launches).toBe(1));
    expect(
      await screen.findByText(t('browser.opened', { name: 'Google Chrome' })),
    ).toBeTruthy();
  });

  it('shows the separate profile, so the usual browser is clearly untouched', async () => {
    render(<SettingsTab />);
    await waitFor(() => expect(screen.getByText(t('browser.section'))).toBeTruthy());
    expect(section().getByText('/home/u/.lanius/browser-profile')).toBeTruthy();
  });

  it('says so when no browser is installed, instead of failing on click', async () => {
    browserState = { ...browserState, available: false, name: null };
    render(<SettingsTab />);
    expect(await screen.findByText(t('browser.unavailable'))).toBeTruthy();
    // And offers no button that could only fail.
    expect(section().queryByRole('button', { name: t('browser.open') })).toBeNull();
  });

  it('warns when HTTPS will not be trusted yet', async () => {
    browserState = { ...browserState, ca_trusted: false };
    render(<SettingsTab />);
    expect(await screen.findByText(t('browser.noCa'))).toBeTruthy();
  });

  it('reports a launch that failed', async () => {
    const user = userEvent.setup();
    launchError = 'no Chromium-based browser found';
    render(<SettingsTab />);
    await waitFor(() => expect(screen.getByText(t('browser.section'))).toBeTruthy());

    await user.click(section().getByRole('button', { name: t('browser.open') }));
    expect(
      await screen.findByText(
        // The server's reason, not the bare status code.
        t('browser.failed', { message: 'no Chromium-based browser found' }),
      ),
    ).toBeTruthy();
  });

  it('clears the browsing data after confirming', async () => {
    const user = userEvent.setup();
    render(<SettingsTab />);
    await waitFor(() => expect(screen.getByText(t('browser.section'))).toBeTruthy());

    await user.click(
      section().getByRole('button', { name: t('browser.clearProfile') }),
    );
    await waitFor(() => expect(cleared).toBe(1));
    expect(await screen.findByText(t('browser.cleared'))).toBeTruthy();
  });

  it('does not clear anything when the confirmation is declined', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('confirm', () => false);
    render(<SettingsTab />);
    await waitFor(() => expect(screen.getByText(t('browser.section'))).toBeTruthy());

    await user.click(
      section().getByRole('button', { name: t('browser.clearProfile') }),
    );
    expect(cleared).toBe(0);
  });
});

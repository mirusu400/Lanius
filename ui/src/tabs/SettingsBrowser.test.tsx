/** Browser selection, proxy launch, and Firefox's manual CA guidance. */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BrowserSection } from './settings/BrowserSection';
import { currentDocsPage, OPEN_DOCS_PAGE } from '../docs/navigation';
import { renderWithI18n as render, t } from '../test-utils';

let browserState: {
  available: boolean;
  name: string | null;
  browsers: { id: string; name: string; available: boolean }[];
  profile: string;
  default_profile: string;
  custom_profile: boolean;
  ca_trusted: boolean;
} = {
  available: true,
  name: 'Google Chrome',
  browsers: [
    { id: 'chrome', name: 'Google Chrome', available: true },
    { id: 'chrome-beta', name: 'Google Chrome Beta', available: false },
    { id: 'chromium', name: 'Chromium', available: false },
  ],
  profile: '/home/u/.lanius/browser-profile',
  default_profile: '/home/u/.lanius/browser-profile',
  custom_profile: false,
  ca_trusted: true,
};
let launches = 0;
let selectedBrowserId: string | null = null;
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
    browsers: [
      { id: 'chrome', name: 'Google Chrome', available: true },
      { id: 'chrome-beta', name: 'Google Chrome Beta', available: false },
      { id: 'chromium', name: 'Chromium', available: false },
    ],
    profile: '/home/u/.lanius/browser-profile',
    default_profile: '/home/u/.lanius/browser-profile',
    custom_profile: false,
    ca_trusted: true,
  };
  launches = 0;
  selectedBrowserId = null;
  launchError = null;
  cleared = 0;

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/browser/profile') && init?.method === 'PUT') {
        const { path } = JSON.parse(String(init.body)) as { path: string | null };
        if (path === '/etc') return jsonResponse({ detail: '/etc already contains other files' }, 422);
        browserState = {
          ...browserState,
          profile: path ?? browserState.default_profile,
          custom_profile: path !== null,
        };
        return jsonResponse(browserState);
      }
      if (url.includes('/api/browser/profile')) {
        cleared += 1;
        return jsonResponse({ cleared: true });
      }
      if (url.includes('/api/browser')) {
        if (init?.method === 'POST') {
          if (launchError) return jsonResponse({ detail: launchError }, 409);
          selectedBrowserId = (JSON.parse(String(init.body)) as { browser_id?: string }).browser_id ?? null;
          launches += 1;
          return jsonResponse({
            id: selectedBrowserId,
            name: selectedBrowserId === 'firefox' ? 'Firefox'
              : selectedBrowserId === 'chrome-beta' ? 'Google Chrome Beta' : 'Google Chrome',
            path: '/fake/chrome',
            pid: 1234,
            profile: browserState.profile,
            proxy: 'http://127.0.0.1:8080',
            ca_trusted: selectedBrowserId !== 'firefox',
          });
        }
        return jsonResponse(browserState);
      }
      if (url.includes('/api/mcp')) {
        return jsonResponse({
          available: true,
          enabled: true,
          url: 'http://127.0.0.1:12954/mcp/mcp',
          host: '127.0.0.1',
          port: 12954,
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
  it('keeps the section visible and retries after an initial load failure', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('engine offline'));
    const user = userEvent.setup();
    render(<BrowserSection />);

    expect(await screen.findByText(t('browser.section'))).toBeTruthy();
    expect(await screen.findByText(t('browser.loadFailed', { message: 'engine offline' }))).toBeTruthy();
    await user.click(screen.getByRole('button', { name: t('common.retry') }));
    expect(await screen.findByText('/home/u/.lanius/browser-profile')).toBeTruthy();
  });

  it('opens a browser through the proxy', async () => {
    const user = userEvent.setup();
    render(<BrowserSection />);
    await waitFor(() => expect(screen.getByText(t('browser.section'))).toBeTruthy());

    await user.click(section().getByRole('button', { name: t('browser.open') }));
    const dialog = await screen.findByRole('dialog', { name: t('browser.choose') });
    expect(within(dialog).getByRole('button', { name: t('browser.openNamed', { name: 'Google Chrome Beta' }) })).toHaveProperty('disabled', true);
    await user.click(within(dialog).getByRole('button', { name: t('browser.openNamed', { name: 'Google Chrome' }) }));
    await waitFor(() => expect(launches).toBe(1));
    expect(selectedBrowserId).toBe('chrome');
    expect(
      await screen.findByText(t('browser.opened', { name: 'Google Chrome' })),
    ).toBeTruthy();
  });

  it('launches the selected Chrome Beta rather than the default Chrome', async () => {
    browserState = {
      ...browserState,
      browsers: browserState.browsers.map((item) =>
        item.id === 'chrome-beta' ? { ...item, available: true } : item),
    };
    const user = userEvent.setup();
    render(<BrowserSection />);
    await user.click(await section().findByRole('button', { name: t('browser.open') }));
    const dialog = await screen.findByRole('dialog', { name: t('browser.choose') });
    await user.click(within(dialog).getByRole('button', { name: t('browser.openNamed', { name: 'Google Chrome Beta' }) }));
    await waitFor(() => expect(selectedBrowserId).toBe('chrome-beta'));
    expect(await screen.findByText(t('browser.opened', { name: 'Google Chrome Beta' }))).toBeTruthy();
  });

  it('shows a clickable CA guide toast after opening Firefox', async () => {
    browserState = {
      ...browserState,
      browsers: [...browserState.browsers, { id: 'firefox', name: 'Firefox', available: true }],
    };
    const openedDocs = vi.fn();
    window.addEventListener(OPEN_DOCS_PAGE, openedDocs);
    const user = userEvent.setup();
    try {
      render(<BrowserSection />);
      await user.click(await section().findByRole('button', { name: t('browser.open') }));
      const dialog = await screen.findByRole('dialog', { name: t('browser.choose') });
      await user.click(within(dialog).getByRole('button', { name: t('browser.openNamed', { name: 'Firefox' }) }));
      expect(selectedBrowserId).toBe('firefox');
      const guide = await screen.findByRole('button', { name: t('browser.firefoxCaToast') });
      await user.click(guide);
      expect(openedDocs).toHaveBeenCalledOnce();
      expect(currentDocsPage()).toBe('guide:firefox-ca');
    } finally {
      window.removeEventListener(OPEN_DOCS_PAGE, openedDocs);
    }
  });

  it('shows the separate profile, so the usual browser is clearly untouched', async () => {
    render(<BrowserSection />);
    await waitFor(() => expect(screen.getByText(t('browser.section'))).toBeTruthy());
    expect(section().getByText('/home/u/.lanius/browser-profile')).toBeTruthy();
  });

  it('says so when no browser is installed, instead of failing on click', async () => {
    browserState = {
      ...browserState,
      available: false,
      name: null,
      browsers: browserState.browsers.map((item) => ({ ...item, available: false })),
    };
    const user = userEvent.setup();
    render(<BrowserSection />);
    expect(await screen.findByText(t('browser.unavailable'))).toBeTruthy();
    await user.click(section().getByRole('button', { name: t('browser.open') }));
    const dialog = await screen.findByRole('dialog', { name: t('browser.choose') });
    expect(within(dialog).getByRole('button', { name: t('browser.openNamed', { name: 'Google Chrome' }) })).toHaveProperty('disabled', true);
    expect(launches).toBe(0);
  });

  it('warns when HTTPS will not be trusted yet', async () => {
    browserState = { ...browserState, ca_trusted: false };
    render(<BrowserSection />);
    expect(await screen.findByText(t('browser.noCa'))).toBeTruthy();
  });

  it('describes Firefox CA trust as a profile setting that is not checked here', async () => {
    browserState = {
      ...browserState,
      name: 'Firefox',
      ca_trusted: false,
      browsers: [{ id: 'firefox', name: 'Firefox', available: true }],
    };
    render(<BrowserSection />);
    expect(await screen.findByText(t('browser.firefoxCaState'))).toBeTruthy();
    expect(screen.queryByText(t('browser.noCa'))).toBeNull();
  });

  it('reports a launch that failed', async () => {
    const user = userEvent.setup();
    launchError = 'no Chromium-based browser found';
    render(<BrowserSection />);
    await waitFor(() => expect(screen.getByText(t('browser.section'))).toBeTruthy());

    await user.click(section().getByRole('button', { name: t('browser.open') }));
    const dialog = await screen.findByRole('dialog', { name: t('browser.choose') });
    await user.click(within(dialog).getByRole('button', { name: t('browser.openNamed', { name: 'Google Chrome' }) }));
    expect(
      await within(dialog).findByText(
        // The server's reason, not the bare status code.
        t('browser.failed', { message: 'no Chromium-based browser found' }),
      ),
    ).toBeTruthy();
  });

  it('clears the browsing data after confirming', async () => {
    const user = userEvent.setup();
    render(<BrowserSection />);
    await waitFor(() => expect(screen.getByText(t('browser.section'))).toBeTruthy());

    await user.click(
      section().getByRole('button', { name: t('browser.clearProfile') }),
    );
    const dialog = await screen.findByRole('dialog', { name: t('browser.clearProfile') });
    expect(cleared).toBe(0);
    await user.click(within(dialog).getByRole('button', { name: t('browser.clearProfile') }));
    await waitFor(() => expect(cleared).toBe(1));
    expect(await screen.findByText(t('browser.cleared'))).toBeTruthy();
  });

  it('does not clear anything when the confirmation is declined', async () => {
    const user = userEvent.setup();
    render(<BrowserSection />);
    await waitFor(() => expect(screen.getByText(t('browser.section'))).toBeTruthy());

    await user.click(
      section().getByRole('button', { name: t('browser.clearProfile') }),
    );
    const dialog = await screen.findByRole('dialog', { name: t('browser.clearProfile') });
    await user.click(within(dialog).getByRole('button', { name: t('common.cancel') }));
    expect(cleared).toBe(0);
  });

  it('switches the browser data directory and back to the default', async () => {
    const user = userEvent.setup();
    render(<BrowserSection />);
    const input = await screen.findByLabelText(t('browser.dataDir'));

    await user.type(input, '/data/account-a');
    await user.click(section().getByRole('button', { name: t('browser.applyDir') }));
    expect(
      await screen.findByText(t('browser.dirChanged', { path: '/data/account-a' })),
    ).toBeTruthy();
    expect(section().getAllByText('/data/account-a').length).toBeGreaterThan(0);

    await user.click(section().getByRole('button', { name: t('browser.defaultDir') }));
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(''));
    expect(browserState.custom_profile).toBe(false);
  });

  it('reports a directory the engine refuses', async () => {
    const user = userEvent.setup();
    render(<BrowserSection />);
    const input = await screen.findByLabelText(t('browser.dataDir'));

    await user.type(input, '/etc{Enter}');
    expect(
      await screen.findByText(
        t('browser.dirFailed', { message: '/etc already contains other files' }),
      ),
    ).toBeTruthy();
    expect(browserState.custom_profile).toBe(false);
  });
});

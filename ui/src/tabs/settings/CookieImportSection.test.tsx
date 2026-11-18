import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import { renderWithI18n as render, t } from '../../test-utils';
import { currentDocsPage } from '../../docs/navigation';
import { CookieImportSection } from './CookieImportSection';
import { searchSettings } from './settingsCatalogue';

const available = {
  profiles: [
    { id: 'chrome:Default', name: 'Google Chrome — Default', browser_id: 'chrome', cookie_count: 12 },
    { id: 'firefox:test.default', name: 'Firefox — test.default', browser_id: 'firefox', cookie_count: 34 },
  ],
  targets: [
    { id: 'chrome', name: 'Google Chrome', available: true, ready: true, open: false },
    { id: 'chrome-beta', name: 'Google Chrome Beta', available: true, ready: true, open: false },
    { id: 'chromium', name: 'Chromium', available: true, ready: true, open: false },
    { id: 'firefox', name: 'Firefox', available: true, ready: true, open: false },
  ],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('imports the selected whole profile into the selected browser after confirmation', async () => {
  const posts: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') posts.push(JSON.parse(String(init.body)));
    return {
      ok: true,
      json: async () => init?.method === 'POST'
        ? { imported: 20, partitioned: 4, expired: 3, unsupported: 2,
          protected: 1, session_extended: 1 }
        : available,
    } as Response;
  }));

  const user = userEvent.setup();
  render(<CookieImportSection />);
  await user.selectOptions(await screen.findByLabelText(t('browser.cookieImportSource')), 'firefox:test.default');
  await user.selectOptions(screen.getByLabelText(t('browser.cookieImportTarget')), 'chrome-beta');
  await user.click(screen.getByRole('button', { name: t('browser.cookieImportButton') }));
  expect(posts).toHaveLength(0);

  const dialog = screen.getByRole('dialog', { name: t('browser.cookieImportSection') });
  expect(dialog.textContent).toContain('test.default');
  await user.click(within(dialog).getByRole('button', { name: t('browser.cookieImportButton') }));
  await waitFor(() => expect(posts).toEqual([{
    source_profile: 'firefox:test.default', target_browser: 'chrome-beta',
  }]));
  expect(await screen.findByText(t('browser.cookieImportResult', {
    imported: '20', partitioned: '4', expired: '3', unsupported: '2', protected: '1', session: '1',
  }))).toBeTruthy();
});

it('refuses import while the selected Lanius browser is open', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, json: async () => ({ ...available, targets: available.targets.map((item) =>
      item.id === 'chrome' ? { ...item, open: true } : item) }),
  } as Response)));
  render(<CookieImportSection />);
  expect(await screen.findByText(t('browser.cookieImportTargetOpen', { browser: 'Google Chrome' }))).toBeTruthy();
  expect(screen.getByRole('button', { name: t('browser.cookieImportButton') }))
    .toHaveProperty('disabled', true);
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
});

it('offers Chrome, Chrome Beta, Chromium and Firefox destinations', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, json: async () => available,
  } as Response)));
  render(<CookieImportSection />);
  const target = await screen.findByLabelText(t('browser.cookieImportTarget'));
  expect((target as HTMLSelectElement).options).toHaveLength(4);
  expect(screen.getByRole('button', { name: t('browser.cookieImportButton') }))
    .toHaveProperty('disabled', false);
  expect(searchSettings('쿠키 가져오기')[0]).toMatchObject({ id: 'cookie-import', group: 'browser' });
});

it('pairs a browser extension when no readable source profile exists', async () => {
  const requests: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith('/extension-ticket') && init?.method === 'POST') {
      requests.push(JSON.parse(String(init.body)));
      return { ok: true, json: async () => ({ code: '12954:one-time-code', expires_seconds: 300 }) } as Response;
    }
    if (path.endsWith('/extension-ticket')) return {
      ok: true, json: async () => ({ phase: 'done', error: null,
        result: { imported: 5, partitioned: 0, expired: 0, unsupported: 0,
          protected: 0, session_extended: 1 } }),
    } as Response;
    return { ok: true, json: async () => ({ ...available, profiles: [] }) } as Response;
  }));
  const user = userEvent.setup();
  render(<CookieImportSection />);
  expect(await screen.findByText(t('browser.cookieImportNoSource'))).toBeTruthy();
  await user.selectOptions(screen.getByLabelText(t('browser.cookieImportTarget')), 'chromium');
  await user.click(screen.getByRole('button', { name: t('browser.cookieImportExtensionPair') }));
  expect(await screen.findByText('12954:one-time-code')).toBeTruthy();
  expect(requests).toEqual([{ target_browser: 'chromium' }]);
  expect(await screen.findByText(t('browser.cookieImportResult', {
    imported: '5', partitioned: '0', expired: '0', unsupported: '0', protected: '0', session: '1',
  }), {}, { timeout: 3000 })).toBeTruthy();
});

it('saves the extension through the native Save As dialog in the desktop app', async () => {
  const invoke = vi.fn(async () => 'C:\Users\tester\lanius-cookie-transfer.zip');
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
  const fetched = vi.fn(async (_input: RequestInfo | URL) => (
    { ok: true, json: async () => available } as Response
  ));
  vi.stubGlobal('fetch', fetched);
  render(<CookieImportSection />);

  await userEvent.setup().click(await screen.findByRole('button', {
    name: t('browser.cookieImportExtensionDownload'),
  }));

  // The desktop webview drops blob downloads, so the shell must do the saving.
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('save_cookie_exporter', {
    title: t('browser.cookieImportExtensionDownload'),
  }));
  expect(fetched.mock.calls.filter(([url]) => String(url).endsWith('/cookies/extension'))).toHaveLength(0);
});

it('opens the cookie import guide in Docs', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => available } as Response)));
  render(<CookieImportSection />);

  await userEvent.setup().click(screen.getByRole('button', { name: t('browser.cookieImportGuide') }));

  expect(currentDocsPage()).toBe('guide:cookie-import');
});

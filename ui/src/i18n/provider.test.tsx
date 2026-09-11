/** Provider behaviour and the Settings language selector. */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithI18n } from '../test-utils';
import { I18nProvider, STORAGE_KEY, useI18n } from './index';
import { SettingsTab } from '../tabs/SettingsTab';

function Probe() {
  const { locale, t } = useI18n();
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="text">{t('common.refresh')}</span>
    </div>
  );
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/ca')) {
        return jsonResponse({
          confdir: '/home/u/.mitmproxy',
          available: { pem: true, cer: true, p12: false },
          install_url: 'http://mitm.it',
          proxy: '127.0.0.1:8080',
        });
      }
      return jsonResponse({
        version: '0.1.0',
        proxy: { running: true, host: '127.0.0.1', port: 8080 },
        flows: 3,
        subscribers: 1,
        db_path: '/db.sqlite',
        intercept: {
          enabled: false,
          intercept_requests: true,
          intercept_responses: false,
          host_filter: null,
        },
        paused: 0,
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('I18nProvider', () => {
  it('renders the requested locale', () => {
    renderWithI18n(<Probe />, { locale: 'ko' });
    expect(screen.getByTestId('locale').textContent).toBe('ko');
    expect(screen.getByTestId('text').textContent).toBe('새로고침');
  });

  it('renders English by default', () => {
    renderWithI18n(<Probe />, { locale: 'en' });
    expect(screen.getByTestId('text').textContent).toBe('Refresh');
  });

  it('sets the document language', async () => {
    renderWithI18n(<Probe />, { locale: 'ko' });
    await waitFor(() => expect(document.documentElement.lang).toBe('ko'));
  });

  it('reads a saved locale from storage', () => {
    window.localStorage.setItem(STORAGE_KEY, 'ko');
    render(<I18nProvider><Probe /></I18nProvider>);
    expect(screen.getByTestId('locale').textContent).toBe('ko');
  });

  it('throws a helpful error outside the provider', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/I18nProvider/);
    quiet.mockRestore();
  });
});

describe('Settings language selector', () => {
  // This suite asserts concrete English and Korean strings, so it always
  // starts from English regardless of VITE_TEST_LOCALE.
  const renderSettings = () => renderWithI18n(<SettingsTab />, { locale: 'en' });

  it('lists every supported language', async () => {
    renderSettings();
    const select = (await screen.findByLabelText(
      'Interface language',
    )) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['en', 'ko']);
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'English',
      '한국어',
    ]);
  });

  it('switches the interface language immediately', async () => {
    const user = userEvent.setup();
    renderSettings();
    // English first
    expect(await screen.findByText('CA certificate')).toBeTruthy();

    await user.selectOptions(screen.getByLabelText('Interface language'), 'ko');

    // The whole tab re-renders in Korean, including its own label.
    expect(await screen.findByText('CA 인증서')).toBeTruthy();
    expect(screen.getByLabelText('인터페이스 언어')).toBeTruthy();
    expect(screen.queryByText('CA certificate')).toBeNull();
  });

  it('remembers the choice for the next launch', async () => {
    const user = userEvent.setup();
    renderSettings();
    await user.selectOptions(
      await screen.findByLabelText('Interface language'),
      'ko',
    );
    await waitFor(() =>
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe('ko'),
    );
  });

  it('interpolates the proxy address into the browser help', async () => {
    renderSettings();
    const help = await screen.findByText(/curl -x http:\/\/127\.0\.0\.1:8080/);
    expect(help).toBeTruthy();
  });

  it('keeps the mitm.it link inside the translated sentence', async () => {
    const user = userEvent.setup();
    renderSettings();
    const link = (await screen.findByText('mitm.it')) as HTMLAnchorElement;
    expect(link.href).toContain('mitm.it');

    await user.selectOptions(screen.getByLabelText('Interface language'), 'ko');
    const korean = (await screen.findByText('mitm.it')) as HTMLAnchorElement;
    expect(korean.href).toContain('mitm.it');
  });

  it('localises the CA download labels', async () => {
    const user = userEvent.setup();
    renderSettings();
    expect(await screen.findByText('Download .pem')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Interface language'), 'ko');
    expect(await screen.findByText('.pem 내려받기')).toBeTruthy();
  });
});

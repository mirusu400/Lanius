/** TLS fingerprint controls in Settings. */
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TlsSection } from './settings/TlsSection';
import { renderWithI18n as render, t, tk, TEST_LOCALE } from '../test-utils';
import { useI18n, type Locale } from '../i18n';

const CHROME = 'TLS_AES_128_GCM_SHA256:ECDHE-RSA-AES128-GCM-SHA256:AES256-SHA';

let tls = {
  profile: 'default',
  custom_ciphers: null as string | null,
  ciphers: null as string | null,
  available: [
    { id: 'default', label: 'mitmproxy default' },
    { id: 'chrome', label: 'Chrome' },
    { id: 'tls12', label: 'Force TLS 1.2' },
  ],
};
let posted: unknown[] = [];
let postFails = false;

beforeEach(() => {
  posted = [];
  postFails = false;
  tls = { ...tls, profile: 'default', custom_ciphers: null, ciphers: null };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      const ok = (body: unknown) =>
        ({ ok: true, status: 200, statusText: 'OK', json: async () => body }) as Response;

      if (path.includes('/api/tls')) {
        if (init?.method === 'POST') {
          const sent = JSON.parse(String(init.body));
          posted.push(sent);
          if (postFails) {
            return {
              ok: false,
              status: 422,
              statusText: 'Unprocessable Entity',
              json: async () => ({ detail: 'no usable ciphers' }),
            } as Response;
          }
          tls = {
            ...tls,
            profile: sent.profile,
            custom_ciphers: sent.ciphers || null,
            ciphers: sent.ciphers || (sent.profile === 'chrome' ? CHROME : null),
          };
        }
        return ok(tls);
      }
      if (path.includes('/api/status')) {
        return ok({
          version: '0.1.0',
          proxy: { running: true, host: '127.0.0.1', port: 8080 },
          flows: 0,
          subscribers: 0,
          db_path: '/tmp/x',
          intercept: {
            enabled: false,
            intercept_requests: true,
            intercept_responses: false,
            host_filter: null,
          },
          paused: 0,
          local_capture: { supported: true, approved: true, detail: null, spec: null },
        });
      }
      return ok({
        confdir: '/tmp/m',
        available: { pem: true },
        install_url: 'http://mitm.it',
        proxy: '127.0.0.1:8080',
      });
    }) as unknown as typeof fetch,
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const profileSelect = () => screen.getByLabelText(t('tls.profile')) as HTMLSelectElement;

describe('TLS fingerprint', () => {
  it('starts on the engine default', async () => {
    render(<TlsSection />);
    await waitFor(() => expect(profileSelect().value).toBe('default'));
  });

  it('offers the profiles the engine reports', async () => {
    render(<TlsSection />);
    await waitFor(() => expect(profileSelect().options.length).toBe(3));
    expect(screen.getByRole('option', { name: 'Chrome' })).toBeTruthy();
  });

  it('applies a profile as soon as it is picked', async () => {
    render(<TlsSection />);
    await waitFor(() => expect(profileSelect()).toBeTruthy());

    await userEvent.selectOptions(profileSelect(), 'chrome');
    await waitFor(() => expect(posted).toEqual([{ profile: 'chrome', ciphers: '' }]));
  });

  it('re-translates the confirmation when the language changes', async () => {
    // The note is raised once and then sits there. Stored as a sentence it
    // would keep the language it was raised in.
    const other: Locale = TEST_LOCALE === 'en' ? 'ko' : 'en';

    function Harness() {
      const { setLocale } = useI18n();
      return (
        <>
          <button type="button" onClick={() => setLocale(other)}>
            switch
          </button>
          <TlsSection />
        </>
      );
    }

    render(<Harness />);
    await waitFor(() => expect(profileSelect()).toBeTruthy());
    await userEvent.selectOptions(profileSelect(), 'chrome');
    expect(await screen.findByText(t('tls.applied'))).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'switch' }));
    expect(await screen.findByText(tk(other)('tls.applied'))).toBeTruthy();
    expect(screen.queryByText(t('tls.applied'))).toBeNull();
  });

  it('reports how many ciphers are offered, so the change is visible', async () => {
    render(<TlsSection />);
    await waitFor(() => expect(profileSelect()).toBeTruthy());
    await userEvent.selectOptions(profileSelect(), 'chrome');

    expect(await screen.findByText(t('tls.active', { count: '3' }))).toBeTruthy();
  });

  it('sends a custom cipher string with the profile', async () => {
    render(<TlsSection />);
    await waitFor(() => expect(profileSelect()).toBeTruthy());

    await userEvent.type(screen.getByLabelText(t('tls.customLabel')), 'AES256-SHA');
    await userEvent.click(screen.getByRole('button', { name: t('tls.apply') }));

    await waitFor(() =>
      expect(posted).toEqual([{ profile: 'default', ciphers: 'AES256-SHA' }]),
    );
  });

  it('surfaces a cipher list the engine refuses', async () => {
    // Storing an unusable list would make every request fail with a 502.
    postFails = true;
    render(<TlsSection />);
    await waitFor(() => expect(profileSelect()).toBeTruthy());

    await userEvent.type(screen.getByLabelText(t('tls.customLabel')), 'NOPE');
    await userEvent.click(screen.getByRole('button', { name: t('tls.apply') }));

    expect(await screen.findByText(/no usable ciphers|422/)).toBeTruthy();
  });

  it('states what the profile does not cover', async () => {
    render(<TlsSection />);
    expect(await screen.findByText(t('tls.limitation'))).toBeTruthy();
  });
});

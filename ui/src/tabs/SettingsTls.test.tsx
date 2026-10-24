/** TLS fingerprint controls in Settings. */
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TlsSection } from './settings/TlsSection';
import { renderWithI18n as render, t, tk, TEST_LOCALE } from '../test-utils';
import { useI18n, type Locale } from '../i18n';

const TLS13 = ['TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256', 'TLS_AES_128_GCM_SHA256'];
const DEFAULT_SELECTED = ['ECDHE-RSA-AES128-GCM-SHA256', 'AES256-SHA'];
const CHROME_SELECTED = ['ECDHE-RSA-AES128-GCM-SHA256', 'AES256-SHA'];
const CHROME = [...TLS13, ...CHROME_SELECTED].join(':');
const SUPPORTED = [
  { name: 'ECDHE-RSA-AES128-GCM-SHA256', protocol: 'TLSv1.2', strength_bits: 128, recommended: true },
  { name: 'AES256-SHA', protocol: 'SSLv3', strength_bits: 256, recommended: true },
  { name: 'DHE-RSA-AES128-GCM-SHA256', protocol: 'TLSv1.2', strength_bits: 128, recommended: true },
  { name: 'ECDHE-ECDSA-AES256-GCM-SHA384', protocol: 'TLSv1.2', strength_bits: 256, recommended: false },
];

let tls = {
  profile: 'default',
  custom_ciphers: null as string | null,
  ciphers: null as string | null,
  selected_ciphers: DEFAULT_SELECTED,
  supported_ciphers: SUPPORTED,
  tls13_ciphers: TLS13,
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
  tls = {
    ...tls,
    profile: 'default',
    custom_ciphers: null,
    ciphers: null,
    selected_ciphers: DEFAULT_SELECTED,
    supported_ciphers: SUPPORTED,
    tls13_ciphers: TLS13,
  };
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
            selected_ciphers: sent.ciphers
              ? sent.ciphers.split(':')
              : sent.profile === 'chrome' ? CHROME_SELECTED : DEFAULT_SELECTED,
            tls13_ciphers: sent.profile === 'tls12' ? [] : TLS13,
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
  it('keeps the section visible and retries after an initial load failure', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('engine offline'));
    const user = userEvent.setup();
    render(<TlsSection />);

    expect(await screen.findByText(t('tls.section'))).toBeTruthy();
    expect(await screen.findByText(t('tls.loadFailed', { message: 'engine offline' }))).toBeTruthy();
    await user.click(screen.getByRole('button', { name: t('common.retry') }));
    await waitFor(() => expect(profileSelect().value).toBe('default'));
  });

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

    expect(await screen.findByText(t('tls.active', { count: '5' }))).toBeTruthy();
  });

  it('adds only engine-supported ciphers and applies the ordered list', async () => {
    render(<TlsSection />);
    await waitFor(() => expect(profileSelect()).toBeTruthy());

    await userEvent.click(screen.getByRole('button', {
      name: t('tls.addCipher', { cipher: 'DHE-RSA-AES128-GCM-SHA256' }),
    }));
    await userEvent.click(screen.getByRole('button', { name: t('tls.apply') }));

    await waitFor(() =>
      expect(posted).toEqual([{
        profile: 'default',
        ciphers: [...DEFAULT_SELECTED, 'DHE-RSA-AES128-GCM-SHA256'].join(':'),
      }]),
    );
  });

  it('lets the user reorder the exact offer before applying it', async () => {
    render(<TlsSection />);
    await waitFor(() => expect(profileSelect()).toBeTruthy());

    await userEvent.click(screen.getByRole('button', {
      name: t('tls.moveCipherDown', { cipher: DEFAULT_SELECTED[0] }),
    }));
    await userEvent.click(screen.getByRole('button', { name: t('tls.apply') }));

    await waitFor(() => expect(posted).toEqual([{
      profile: 'default',
      ciphers: [...DEFAULT_SELECTED].reverse().join(':'),
    }]));
  });

  it('restores the selected profile instead of making users rebuild its list', async () => {
    tls = {
      ...tls,
      custom_ciphers: 'AES256-SHA',
      ciphers: 'AES256-SHA',
      selected_ciphers: ['AES256-SHA'],
    };
    render(<TlsSection />);

    await userEvent.click(await screen.findByRole('button', { name: t('tls.useProfileDefaults') }));
    await waitFor(() => expect(posted).toEqual([{ profile: 'default', ciphers: '' }]));
  });

  it('searches the supported catalogue instead of accepting free text', async () => {
    render(<TlsSection />);
    await waitFor(() => expect(profileSelect()).toBeTruthy());

    await userEvent.type(screen.getByRole('searchbox', { name: t('tls.searchCiphers') }), 'DHE-RSA');
    expect(screen.getByRole('button', {
      name: t('tls.addCipher', { cipher: 'DHE-RSA-AES128-GCM-SHA256' }),
    })).toBeTruthy();
    expect(screen.queryByRole('button', {
      name: t('tls.addCipher', { cipher: 'ECDHE-ECDSA-AES256-GCM-SHA384' }),
    })).toBeNull();
  });

  it('keeps non-recommended compatibility ciphers behind an explicit choice', async () => {
    render(<TlsSection />);
    await waitFor(() => expect(profileSelect()).toBeTruthy());

    const name = t('tls.addCipher', { cipher: 'ECDHE-ECDSA-AES256-GCM-SHA384' });
    expect(screen.queryByRole('button', { name })).toBeNull();
    await userEvent.click(screen.getByRole('checkbox', { name: t('tls.showAllCiphers') }));
    expect(screen.getByRole('button', { name })).toBeTruthy();
  });

  it('surfaces a cipher list the engine refuses', async () => {
    postFails = true;
    render(<TlsSection />);
    await waitFor(() => expect(profileSelect()).toBeTruthy());

    await userEvent.click(screen.getByRole('button', {
      name: t('tls.addCipher', { cipher: 'DHE-RSA-AES128-GCM-SHA256' }),
    }));
    await userEvent.click(screen.getByRole('button', { name: t('tls.apply') }));

    expect(await screen.findByText(/no usable ciphers|422/)).toBeTruthy();
  });

  it('states what the profile does not cover', async () => {
    render(<TlsSection />);
    expect(await screen.findByText(t('tls.limitation'))).toBeTruthy();
  });
});

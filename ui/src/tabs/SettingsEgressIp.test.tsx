import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { renderWithI18n as render, t } from '../test-utils';
import { EgressIpSection } from './settings/EgressIpSection';

const base = {
  enabled: false,
  interval_seconds: 180 as const,
  ipv4_url: 'https://api.ipify.org',
  ipv6_url: 'https://api6.ipify.org',
  blocked_by_lockdown: false,
  last_checked_at: null,
  last_success_at: null,
  errors: { ipv4: null, ipv6: null },
  current: { ipv4: null, ipv6: null },
  history: [],
};

let posted: unknown[] = [];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  posted = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.method === 'PUT' ? JSON.parse(String(init.body)) as unknown : null;
    if (body) posted.push(body);
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: async () => body ? { ...base, ...body as object } : base,
    } as Response;
  }));
});

it('is off by default and saves separate IPv4 and IPv6 observer URLs', async () => {
  const user = userEvent.setup();
  render(<EgressIpSection />);
  const toggle = await screen.findByRole('checkbox', { name: t('egressIp.enabled') });
  expect((toggle as HTMLInputElement).checked).toBe(false);

  await user.click(toggle);
  await user.selectOptions(screen.getByLabelText(t('egressIp.interval')), '300');
  const ipv4 = screen.getByLabelText(t('egressIp.ipv4Url'));
  const ipv6 = screen.getByLabelText(t('egressIp.ipv6Url'));
  await user.clear(ipv4);
  await user.type(ipv4, 'https://observer.example/v4');
  await user.clear(ipv6);
  await user.type(ipv6, 'https://observer.example/v6');
  await user.click(screen.getByRole('button', { name: t('egressIp.apply') }));

  await waitFor(() => expect(posted).toEqual([{
    enabled: true,
    interval_seconds: 300,
    ipv4_url: 'https://observer.example/v4',
    ipv6_url: 'https://observer.example/v6',
  }]));
});

it('makes the Lockdown storage refusal explicit', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: async () => ({ ...base, enabled: true, blocked_by_lockdown: true }),
  } as Response)));
  render(<EgressIpSection />);
  expect(await screen.findByText(t('egressIp.lockdown'))).toBeTruthy();
});

it('loads public IP history into a modal', async () => {
  const history = [{
    id: 2,
    family: 4 as const,
    ip: '1.1.1.1',
    first_seen_at: 1_700_000_000,
    last_seen_at: 1_700_000_120,
    check_count: 3,
    observer_url: 'https://observer.example/v4',
  }, {
    id: 1,
    family: 6 as const,
    ip: '2001:4860:4860::8888',
    first_seen_at: 1_699_999_000,
    last_seen_at: 1_699_999_000,
    check_count: 1,
    observer_url: 'https://observer.example/v6',
  }];
  const requested: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    requested.push(String(url));
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: async () => String(url).includes('history_limit=1000')
        ? { ...base, history }
        : base,
    } as Response;
  }));

  const user = userEvent.setup();
  render(<EgressIpSection />);
  await user.click(await screen.findByRole('button', { name: t('egressIp.viewHistory') }));

  const dialog = await screen.findByRole('dialog', { name: t('egressIp.historyTitle') });
  expect(dialog.textContent).toContain('1.1.1.1');
  expect(dialog.textContent).toContain('2001:4860:4860::8888');
  expect(dialog.textContent).toContain('https://observer.example/v4');
  expect(dialog.textContent).toContain(t('egressIp.historyCount', { count: '2' }));
  expect(requested.some((url) => url.endsWith('/api/egress-ip?history_limit=1000'))).toBe(true);
});

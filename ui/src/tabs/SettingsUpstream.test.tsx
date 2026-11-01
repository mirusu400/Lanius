import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import { renderWithI18n as render, t } from '../test-utils';
import { UpstreamSection } from './settings/UpstreamSection';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('applies an upstream route and can switch back to direct', async () => {
  let hops: string[] = [];
  const posted: string[][] = [];
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      hops = (JSON.parse(String(init.body)) as { hops: string[] }).hops;
      posted.push(hops);
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        enabled: hops.length > 0,
        hops,
        url: hops.length === 1 ? hops[0] : null,
        authentication: hops.map(() => null),
      }),
      headers: new Headers({ 'Content-Type': 'application/json' }),
    } as Response;
  }));

  const user = userEvent.setup();
  render(<UpstreamSection />);
  const mode = await screen.findByLabelText(t('upstream.mode'));
  await user.selectOptions(mode, 'upstream');
  await user.type(screen.getByLabelText(t('upstream.hop', { number: 1 })), 'http://127.0.0.1:8081');
  await user.click(screen.getByRole('button', { name: t('upstream.apply') }));
  await waitFor(() => expect(posted).toEqual([['http://127.0.0.1:8081']]));

  await user.selectOptions(mode, 'direct');
  await user.click(screen.getByRole('button', { name: t('upstream.apply') }));
  await waitFor(() => expect(posted).toEqual([['http://127.0.0.1:8081'], []]));
});

it('sends per-hop credentials without reading a saved password back', async () => {
  let state = {
    enabled: false,
    hops: [] as string[],
    url: null as string | null,
    authentication: [] as ({ username: string; password_set: boolean } | null)[],
  };
  const posted: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as {
        hops: string[];
        authentication: ({ username: string; password?: string } | null)[];
      };
      posted.push(body);
      state = {
        enabled: body.hops.length > 0,
        hops: body.hops,
        url: body.hops.length === 1 ? body.hops[0] : null,
        authentication: body.authentication.map((entry) => entry
          ? { username: entry.username, password_set: true }
          : null),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => state,
      headers: new Headers({ 'Content-Type': 'application/json' }),
    } as Response;
  }));

  const user = userEvent.setup();
  render(<UpstreamSection />);
  await user.selectOptions(await screen.findByLabelText(t('upstream.mode')), 'upstream');
  await user.type(
    screen.getByLabelText(t('upstream.hop', { number: 1 })),
    'http://proxy.example:8080',
  );
  await user.click(screen.getByRole('checkbox', { name: t('upstream.authentication') }));
  await user.type(screen.getByLabelText(t('upstream.username')), 'alice');
  await user.type(screen.getByLabelText(t('upstream.password')), 'secret');
  await user.click(screen.getByRole('button', { name: t('upstream.apply') }));

  await waitFor(() => expect(posted).toEqual([{
    hops: ['http://proxy.example:8080'],
    authentication: [{ username: 'alice', password: 'secret' }],
  }]));
  const password = screen.getByLabelText(t('upstream.password')) as HTMLInputElement;
  expect(password.value).toBe('');
  expect(password.placeholder).toBe(t('upstream.passwordSaved'));

  const address = screen.getByLabelText(t('upstream.hop', { number: 1 }));
  await user.clear(address);
  await user.type(address, 'http://other.example:8080');
  expect((screen.getByRole('button', { name: t('upstream.apply') }) as HTMLButtonElement).disabled).toBe(true);
  await user.type(password, 'new-secret');
  expect((screen.getByRole('button', { name: t('upstream.apply') }) as HTMLButtonElement).disabled).toBe(false);
});

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
      json: async () => ({ enabled: hops.length > 0, hops, url: hops.length === 1 ? hops[0] : null }),
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

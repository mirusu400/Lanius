/** Cleanup previews and confirms the exact targets before removing requests. */

import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { renderWithI18n as render, t } from '../../test-utils';
import { ProjectCompactSection } from './ProjectCompactSection';

const targets = [
  { scheme: 'https', host: 'keep.test', port: 443, flows: 2, content_bytes: 1024, in_scope: true },
  { scheme: 'https', host: 'noise.test', port: 443, flows: 3, content_bytes: 2048, in_scope: false },
];

const calls: { method: string; body: unknown }[] = [];

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'POST') calls.push({ method, body: JSON.parse(String(init?.body)) });
    const body = method === 'POST'
      ? { deleted: 3, before_bytes: 4096, after_bytes: 2048, reclaimed_bytes: 2048, reclaim_error: null }
      : { db_bytes: 4096, reclaimable_bytes: 0, total_flows: 5, sites: targets };
    return { ok: true, json: async () => body } as Response;
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('selects out-of-scope traffic and sends only that target after confirmation', async () => {
  const user = userEvent.setup();
  render(<ProjectCompactSection />);
  await screen.findByText('noise.test', { exact: false });

  await user.click(screen.getByRole('button', { name: t('compact.selectOut') }));
  expect(screen.getByRole('checkbox', { name: /noise\.test/ })).toHaveProperty('checked', true);
  expect(screen.getByRole('checkbox', { name: /keep\.test/ })).toHaveProperty('checked', false);
  await user.click(screen.getByRole('button', { name: t('compact.delete') }));
  expect(calls).toHaveLength(0);

  const dialog = screen.getByRole('dialog', { name: t('compact.confirmTitle') });
  await user.click(within(dialog).getByRole('button', { name: t('common.cancel') }));
  expect(calls).toHaveLength(0);

  await user.click(screen.getByRole('button', { name: t('compact.delete') }));
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: t('compact.delete') }));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0].body).toEqual({
    sites: [{ scheme: 'https', host: 'noise.test', port: 443, flows: 3 }],
  });
});

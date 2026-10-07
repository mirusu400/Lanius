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
    operation_id: expect.any(String),
    sites: [{ scheme: 'https', host: 'noise.test', port: 443, flows: 3 }],
  });
});

it('shows real deletion progress and the current phase while compaction is pending', async () => {
  let finishPost!: (value: Response) => void;
  const post = new Promise<Response>((resolve) => { finishPost = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') return post;
    const body = path.includes('/progress/')
      ? { operation_id: path.split('/').at(-1), phase: 'deleting', processed_flows: 2, total_flows: 3 }
      : { db_bytes: 4096, reclaimable_bytes: 0, total_flows: 5, sites: targets };
    return { ok: true, json: async () => body } as Response;
  }));

  const user = userEvent.setup();
  render(<ProjectCompactSection />);
  await screen.findByText('noise.test', { exact: false });
  await user.click(screen.getByRole('button', { name: t('compact.selectOut') }));
  await user.click(screen.getByRole('button', { name: t('compact.delete') }));
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: t('compact.delete') }));

  expect(await screen.findByText(t('compact.phase.deleting'))).toBeTruthy();
  expect(screen.getByRole('progressbar')).toHaveProperty('value', 2);
  expect(screen.getByText(t('compact.deletionProgress', { percent: 67, processed: 2, total: 3 }))).toBeTruthy();
  expect(screen.getByText(t('compact.elapsed', { seconds: 0 }))).toBeTruthy();

  finishPost({
    ok: true,
    json: async () => ({ deleted: 3, before_bytes: 4096, after_bytes: 2048, reclaimed_bytes: 2048, reclaim_error: null }),
  } as Response);
  await screen.findByText(t('compact.deleted', { deleted: 3, bytes: '2.0 KB' }));
});

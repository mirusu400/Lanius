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

function progressSnapshot(path: string, overrides: Record<string, unknown> = {}) {
  return {
    operation_id: path.split('/').at(-1),
    phase: 'deleting',
    processed_flows: 2,
    total_flows: 3,
    active: true,
    elapsed_seconds: 75,
    percent: 41.6,
    eta_seconds: 40,
    estimated: false,
    ...overrides,
  };
}

it('covers the app with measured progress, elapsed and remaining time', async () => {
  let finishPost!: (value: Response) => void;
  const post = new Promise<Response>((resolve) => { finishPost = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') return post;
    const body = path.endsWith('/progress')
      ? { active: false }
      : path.includes('/progress/')
        ? progressSnapshot(path)
        : { db_bytes: 4096, reclaimable_bytes: 0, total_flows: 5, sites: targets };
    return { ok: true, json: async () => body } as Response;
  }));

  const user = userEvent.setup();
  render(<ProjectCompactSection />);
  await screen.findByText('noise.test', { exact: false });
  await user.click(screen.getByRole('button', { name: t('compact.selectOut') }));
  await user.click(screen.getByRole('button', { name: t('compact.delete') }));
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: t('compact.delete') }));

  const overlay = await screen.findByRole('dialog', { name: t('compact.progressTitle') });
  await waitFor(() => expect(overlay).toHaveProperty('open', true));
  expect(await within(overlay).findByText(t('compact.phase.deleting'))).toBeTruthy();
  expect(within(overlay).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('41');
  expect(within(overlay).getByText(t('compact.deletionCount', { processed: '2', total: '3' }))).toBeTruthy();
  const times = `${t('compact.elapsedTime', { time: t('compact.duration.minutes', { minutes: 1, seconds: 15 }) })}`
    + ` · ${t('compact.remaining', { time: t('compact.duration.seconds', { seconds: 40 }) })}`;
  expect(within(overlay).getByText(times)).toBeTruthy();

  // Escape must not drop the shield while the database is held.
  overlay.dispatchEvent(new Event('cancel', { cancelable: true }));
  expect(overlay).toHaveProperty('open', true);
  // Chromium closes anyway on a repeated Escape; the shield comes straight back.
  (overlay as HTMLDialogElement).close();
  overlay.dispatchEvent(new Event('close'));
  expect(overlay).toHaveProperty('open', true);

  finishPost({
    ok: true,
    json: async () => ({ deleted: 3, before_bytes: 4096, after_bytes: 2048, reclaimed_bytes: 2048, reclaim_error: null }),
  } as Response);
  await screen.findByText(t('compact.deleted', { deleted: 3, bytes: '2.0 KB' }));
  await waitFor(() => expect(overlay).toHaveProperty('open', false));
});

it('marks inferred phases as estimates and admits when time left is unknown', async () => {
  let finishPost!: (value: Response) => void;
  const post = new Promise<Response>((resolve) => { finishPost = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') return post;
    const body = path.endsWith('/progress')
      ? { active: false }
      : path.includes('/progress/')
        ? progressSnapshot(path, { phase: 'vacuuming', estimated: true, eta_seconds: null })
        : { db_bytes: 4096, reclaimable_bytes: 0, total_flows: 5, sites: targets };
    return { ok: true, json: async () => body } as Response;
  }));

  const user = userEvent.setup();
  render(<ProjectCompactSection />);
  await screen.findByText(t('compact.onlyVacuum'));
  await user.click(screen.getByRole('button', { name: t('compact.onlyVacuum') }));

  const overlay = await screen.findByRole('dialog', { name: t('compact.progressTitle') });
  expect(await within(overlay).findByText(t('compact.phase.vacuuming'))).toBeTruthy();
  expect(within(overlay).queryByRole('progressbar')).toBeNull();
  expect(within(overlay).getByText(t('compact.estimate'))).toBeTruthy();
  expect(within(overlay).getByText(t('compact.remainingUnknown'), { exact: false })).toBeTruthy();
  expect(within(overlay).getByText(t('compact.longStep'))).toBeTruthy();

  finishPost({
    ok: true,
    json: async () => ({ deleted: 0, before_bytes: 4096, after_bytes: 2048, reclaimed_bytes: 2048, reclaim_error: null }),
  } as Response);
  await screen.findByText(t('compact.compacted', { deleted: 0, bytes: '2.0 KB' }));
});

it('reattaches to a cleanup that was already running and releases when it ends', async () => {
  let finished = false;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    const body = path.endsWith('/progress')
      ? progressSnapshot('/running-op')
      : path.includes('/progress/')
        ? progressSnapshot(path, finished ? { active: false, phase: 'done', percent: 100 } : {})
        : { db_bytes: 4096, reclaimable_bytes: 0, total_flows: 5, sites: targets };
    return { ok: true, json: async () => body } as Response;
  }));

  render(<ProjectCompactSection />);
  const overlay = await screen.findByRole('dialog', { name: t('compact.progressTitle') });
  await waitFor(() => expect(overlay).toHaveProperty('open', true));
  expect(screen.getByRole('button', { name: t('compact.working') })).toHaveProperty('disabled', true);

  finished = true;
  await waitFor(() => expect(overlay).toHaveProperty('open', false), { timeout: 3000 });
  expect(screen.getByRole('button', { name: t('compact.delete') })).toBeTruthy();
});

it('lets go of a followed cleanup the engine no longer knows about', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith('/progress')) {
      return { ok: true, json: async () => progressSnapshot('/lost-op') } as Response;
    }
    if (path.includes('/progress/')) {
      return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({ detail: 'compaction not found' }) } as Response;
    }
    return { ok: true, json: async () => ({ db_bytes: 4096, reclaimable_bytes: 0, total_flows: 5, sites: targets }) } as Response;
  }));

  render(<ProjectCompactSection />);
  expect(await screen.findByRole('button', { name: t('compact.working') })).toBeTruthy();
  await waitFor(
    () => expect(screen.getByRole('button', { name: t('compact.delete') })).toBeTruthy(),
    { timeout: 4000 },
  );
  expect(screen.getByRole('alert').textContent).toBe(t('compact.phase.failed'));
});

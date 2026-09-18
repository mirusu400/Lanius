/** The payload library dialog. */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PayloadLibrary } from './PayloadLibrary';
import { renderWithI18n as render, t } from '../test-utils';

const SECLIST_URL =
  'https://raw.githubusercontent.com/danielmiessler/SecLists/2024.3/x/common.txt';

let sets = [
  { id: 's1', name: 'admin paths', count: 42, source: null, created_at: 1, updated_at: 1 },
  { id: 's2', name: 'from seclists', count: 4700, source: SECLIST_URL, created_at: 1, updated_at: 1 },
];

const wordlists = [
  {
    id: 'web-common',
    name: 'Common web content',
    category: 'discovery',
    approx_lines: 4700,
    url: SECLIST_URL,
  },
  {
    id: 'sqli',
    name: 'SQL injection payloads',
    category: 'fuzzing',
    approx_lines: 250,
    url: 'https://raw.githubusercontent.com/danielmiessler/SecLists/2024.3/x/sqli.txt',
  },
];

let onUse: ReturnType<typeof vi.fn<(payloads: string) => void>>;
let onClose: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  onUse = vi.fn<(payloads: string) => void>();
  onClose = vi.fn<() => void>();
  sets = [
    { id: 's1', name: 'admin paths', count: 42, source: null, created_at: 1, updated_at: 1 },
    { id: 's2', name: 'from seclists', count: 4700, source: SECLIST_URL, created_at: 1, updated_at: 1 },
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const json = (body: unknown) =>
        ({ ok: true, status: 200, statusText: 'OK', json: async () => body }) as Response;

      if (url.includes('/api/payload-sets/s1')) {
        if (init?.method === 'DELETE') {
          sets = sets.filter((s) => s.id !== 's1');
          return json({ ok: true });
        }
        if (init?.method === 'PATCH') {
          sets = sets.map((s) => (s.id === 's1' ? { ...s, name: 'renamed' } : s));
          return json(sets[0]);
        }
        return json({ ...sets[0], payloads: ['admin', 'login', 'wp-admin'] });
      }
      if (url.includes('/api/payload-sets/s2')) {
        return json({ ...sets[1], payloads: Array.from({ length: 300 }, (_, i) => `p${i}`) });
      }
      if (url.includes('/api/wordlists/import')) {
        const added = { id: 's3', name: 'SQL injection payloads', count: 250, source: wordlists[1].url, created_at: 1, updated_at: 1 };
        sets = [...sets, added];
        return json(added);
      }
      if (url.includes('/api/payload-sets/s3')) {
        return json({ id: 's3', name: 'SQL injection payloads', count: 2, source: null, created_at: 1, updated_at: 1, payloads: ["' OR 1=1", "'--"] });
      }
      if (url.includes('/api/wordlists')) return json({ items: wordlists, ref: '2024.3' });
      if (url.includes('/api/payload-sets')) return json({ items: sets });
      return json({});
    }) as unknown as typeof fetch,
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function open() {
  render(<PayloadLibrary open onClose={onClose} onUse={onUse} />);
}

describe('PayloadLibrary', () => {
  it('opens as a dialog, not a strip above the editor', async () => {
    // The strip was 260px tall, too small to read a list in.
    open();
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('lists what is saved', async () => {
    open();
    expect(await screen.findByText('admin paths')).toBeTruthy();
  });

  it('shows what is in a list before it is used', async () => {
    // The point of the preview: judging a list without running it.
    open();
    await userEvent.click(await screen.findByText('admin paths'));
    expect(await screen.findByText(/wp-admin/)).toBeTruthy();
  });

  it('hands the chosen payloads back', async () => {
    open();
    await userEvent.click(await screen.findByText('admin paths'));
    await screen.findByText(/wp-admin/);
    await userEvent.click(screen.getByRole('button', { name: t('payloads.use') }));
    expect(onUse).toHaveBeenCalledWith('admin\nlogin\nwp-admin');
  });

  it('cannot use a list before one is chosen', async () => {
    open();
    await screen.findByText('admin paths');
    const use = screen.getByRole('button', { name: t('payloads.use') });
    expect((use as HTMLButtonElement).disabled).toBe(true);
  });

  it('closes after a list is used', async () => {
    open();
    await userEvent.click(await screen.findByText('admin paths'));
    await screen.findByText(/wp-admin/);
    await userEvent.click(screen.getByRole('button', { name: t('payloads.use') }));
    expect(onClose).toHaveBeenCalled();
  });

  it('caps the preview rather than rendering thousands of lines', async () => {
    open();
    await userEvent.click(await screen.findByText('from seclists'));
    expect(await screen.findByText(t('payloads.previewMore', { count: '100' }))).toBeTruthy();
  });

  it('offers SecLists on its own tab', async () => {
    open();
    await userEvent.click(await screen.findByRole('button', { name: t('payloads.seclists') }));
    expect(await screen.findByText('Common web content')).toBeTruthy();
  });

  it('marks a wordlist that has already been downloaded', async () => {
    // So it is not fetched again without meaning to.
    open();
    await userEvent.click(await screen.findByRole('button', { name: t('payloads.seclists') }));
    const row = (await screen.findByText('Common web content')).closest('li')!;
    expect(within(row).getByText(t('payloads.downloaded'))).toBeTruthy();
  });

  it('does not mark one that has not', async () => {
    open();
    await userEvent.click(await screen.findByRole('button', { name: t('payloads.seclists') }));
    const row = (await screen.findByText('SQL injection payloads')).closest('li')!;
    expect(within(row).queryByText(t('payloads.downloaded'))).toBeNull();
  });

  it('downloads a wordlist and shows it straight away', async () => {
    open();
    await userEvent.click(await screen.findByRole('button', { name: t('payloads.seclists') }));
    await userEvent.click(await screen.findByText('SQL injection payloads'));
    await waitFor(() => {
      const urls = vi.mocked(fetch).mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes('/api/wordlists/import'))).toBe(true);
    });
    expect(await screen.findByText(/OR 1=1/)).toBeTruthy();
  });

  it('renames a set in place', async () => {
    // Saving under a new name would leave two sets, since save is keyed
    // by name.
    vi.stubGlobal('prompt', vi.fn(() => 'renamed'));
    open();
    await screen.findByText('admin paths');
    const row = screen.getByText('admin paths').closest('li')!;
    await userEvent.click(within(row).getByRole('button', { name: t('payloads.rename') }));
    expect(await screen.findByText('renamed')).toBeTruthy();
  });

  it('deletes a set', async () => {
    open();
    await screen.findByText('admin paths');
    const row = screen.getByText('admin paths').closest('li')!;
    await userEvent.click(within(row).getByRole('button', { name: t('common.delete') }));
    await waitFor(() => expect(screen.queryByText('admin paths')).toBeNull());
  });

  it('closes on the close button', async () => {
    open();
    await userEvent.click(await screen.findByRole('button', { name: t('common.close') }));
    expect(onClose).toHaveBeenCalled();
  });

  it('does not reach the network while closed', () => {
    // Nothing should be fetched because a tab was rendered.
    render(<PayloadLibrary open={false} onClose={onClose} onUse={onUse} />);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('still lists saved sets when SecLists cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/wordlists')) throw new Error('offline');
        return { ok: true, status: 200, statusText: 'OK', json: async () => ({ items: sets }) } as Response;
      }) as unknown as typeof fetch,
    );
    open();
    expect(await screen.findByText('admin paths')).toBeTruthy();
  });
});

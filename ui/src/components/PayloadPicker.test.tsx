/** Picking payloads: typed, saved, or fetched. */
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PayloadPicker } from './PayloadPicker';
import { renderWithI18n as render, t } from '../test-utils';

const savedSets = [
  { id: 's1', name: 'admin paths', count: 42, source: null, created_at: 1, updated_at: 1 },
];

const wordlists = [
  {
    id: 'web-common',
    name: 'Common web content',
    category: 'discovery',
    approx_lines: 4700,
    url: 'https://raw.githubusercontent.com/x/2024.3/common.txt',
  },
];

let onChange: ReturnType<typeof vi.fn<(payloads: string) => void>>;

beforeEach(() => {
  onChange = vi.fn<(payloads: string) => void>();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const json = (body: unknown) =>
        ({ ok: true, status: 200, statusText: 'OK', json: async () => body }) as Response;

      if (url.includes('/api/payload-sets/s1')) {
        return json({ ...savedSets[0], payloads: ['a', 'b', 'c'] });
      }
      if (url.includes('/api/payload-sets') && init?.method === 'POST') {
        return json({ id: 'new', name: 'typed', count: 2, source: null, created_at: 1, updated_at: 1 });
      }
      if (url.includes('/api/payload-sets') && init?.method === 'DELETE') {
        return json({ ok: true });
      }
      if (url.includes('/api/payload-sets')) return json({ items: savedSets });
      if (url.includes('/api/wordlists/import')) {
        return json({ id: 'imported', name: 'Common web content', count: 4700, source: null, created_at: 1, updated_at: 1 });
      }
      if (url.includes('/api/wordlists')) return json({ items: wordlists, ref: '2024.3' });
      return json({});
    }) as unknown as typeof fetch,
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PayloadPicker', () => {
  it('lets a list be typed directly', async () => {
    render(<PayloadPicker index={0} value="" onChange={onChange} />);
    await userEvent.type(screen.getByRole('textbox'), 'abc');
    expect(onChange).toHaveBeenCalled();
  });

  it('shows how many payloads there are', () => {
    render(<PayloadPicker index={0} value={'a\nb\nc'} onChange={onChange} />);
    expect(screen.getByText(t('payloads.count', { count: '3' }))).toBeTruthy();
  });

  it('does not count blank lines', () => {
    // They come from how a file ends, not from anything to send.
    render(<PayloadPicker index={0} value={'a\n\n\nb\n'} onChange={onChange} />);
    expect(screen.getByText(t('payloads.count', { count: '2' }))).toBeTruthy();
  });

  it('does not reach the network until the library is opened', async () => {
    // Nothing should be fetched because a tab was rendered.
    render(<PayloadPicker index={0} value="" onChange={onChange} />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const urls = vi.mocked(fetch).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/api/wordlists'))).toBe(false);
  });

  it('lists saved sets when the library is opened', async () => {
    render(<PayloadPicker index={0} value="" onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: t('payloads.library') }));
    expect(await screen.findByText('admin paths')).toBeTruthy();
  });

  it('loads a saved set into the editor', async () => {
    // The whole point: a wordlist pasted once, not every time.
    render(<PayloadPicker index={0} value="" onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: t('payloads.library') }));
    await userEvent.click(await screen.findByText('admin paths'));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('a\nb\nc'));
  });

  it('offers SecLists only once the library is open', async () => {
    render(<PayloadPicker index={0} value="" onChange={onChange} />);
    expect(screen.queryByText('Common web content')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: t('payloads.library') }));
    expect(await screen.findByText('Common web content')).toBeTruthy();
  });

  it('says roughly how big a wordlist is before fetching it', async () => {
    render(<PayloadPicker index={0} value="" onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: t('payloads.library') }));
    expect(
      await screen.findByText(t('payloads.approx', { count: '4700' })),
    ).toBeTruthy();
  });

  it('fetches a wordlist and loads it', async () => {
    render(<PayloadPicker index={0} value="" onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: t('payloads.library') }));
    await userEvent.click(await screen.findByText('Common web content'));
    await waitFor(() => {
      const urls = vi.mocked(fetch).mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes('/api/wordlists/import'))).toBe(true);
    });
  });

  it('cannot save an empty list', () => {
    render(<PayloadPicker index={0} value="" onChange={onChange} />);
    const save = screen.getByRole('button', { name: t('payloads.save') });
    expect((save as HTMLButtonElement).disabled).toBe(true);
  });

  it('saves a typed list under a name', async () => {
    vi.stubGlobal('prompt', vi.fn(() => 'my set'));
    render(<PayloadPicker index={0} value={'a\nb'} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: t('payloads.save') }));
    await waitFor(() => {
      const posted = vi
        .mocked(fetch)
        .mock.calls.find(
          (c) => String(c[0]).includes('/api/payload-sets') && c[1]?.method === 'POST',
        );
      expect(posted).toBeTruthy();
    });
  });

  it('does not save when the name is cancelled', async () => {
    vi.stubGlobal('prompt', vi.fn(() => null));
    render(<PayloadPicker index={0} value={'a\nb'} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: t('payloads.save') }));
    const posted = vi
      .mocked(fetch)
      .mock.calls.find(
        (c) => String(c[0]).includes('/api/payload-sets') && c[1]?.method === 'POST',
      );
    expect(posted).toBeUndefined();
  });

  it('keeps working when the engine cannot list sets', async () => {
    // A saved set being unavailable must not stop a list being typed.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch,
    );
    render(<PayloadPicker index={0} value="x" onChange={onChange} />);
    expect(screen.getByRole('textbox')).toBeTruthy();
  });
});

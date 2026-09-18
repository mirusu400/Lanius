/** The payload box for one attack position. */
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PayloadPicker } from './PayloadPicker';
import { renderWithI18n as render, t } from '../test-utils';

let onChange: ReturnType<typeof vi.fn<(payloads: string) => void>>;

beforeEach(() => {
  onChange = vi.fn<(payloads: string) => void>();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const json = (body: unknown) =>
        ({ ok: true, status: 200, statusText: 'OK', json: async () => body }) as Response;
      if (String(input).includes('/api/payload-sets') && init?.method === 'POST') {
        return json({ id: 'new', name: 'typed', count: 2, source: null, created_at: 1, updated_at: 1 });
      }
      if (String(input).includes('/api/wordlists')) return json({ items: [], ref: '2024.3' });
      return json({ items: [] });
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

  it('keeps the library closed until it is asked for', () => {
    render(<PayloadPicker index={0} value="" onChange={onChange} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens the library as a dialog', async () => {
    // It used to be a 260px strip, too small to read a list in.
    render(<PayloadPicker index={0} value="" onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: t('payloads.library') }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('does not reach the network until the library is opened', () => {
    render(<PayloadPicker index={0} value="" onChange={onChange} />);
    expect(fetch).not.toHaveBeenCalled();
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
    const posted = vi
      .mocked(fetch)
      .mock.calls.find(
        (c) => String(c[0]).includes('/api/payload-sets') && c[1]?.method === 'POST',
      );
    expect(posted).toBeTruthy();
  });

  it('does not save when the name is cancelled', async () => {
    vi.stubGlobal('prompt', vi.fn(() => null));
    render(<PayloadPicker index={0} value={'a\nb'} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: t('payloads.save') }));
    expect(fetch).not.toHaveBeenCalled();
  });
});

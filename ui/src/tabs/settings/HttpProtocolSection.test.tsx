import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithI18n as render, t } from '../../test-utils';
import { HttpProtocolSection } from './HttpProtocolSection';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('loads the project mode and applies a selected mode through the engine', async () => {
  const updates: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    if (init?.method === 'PUT') updates.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ mode: init?.method === 'PUT' ? 'http1.0' : 'http2' }) };
  }));
  render(<HttpProtocolSection />);
  const select = screen.getByRole('combobox', { name: t('httpProtocol.section') }) as HTMLSelectElement;
  await waitFor(() => expect(select.value).toBe('http2'));
  fireEvent.change(select, { target: { value: 'http1.0' } });
  await waitFor(() => expect(select.value).toBe('http1.0'));
  expect(updates).toEqual([{ mode: 'http1.0' }]);
});

it('keeps the confirmed mode when the engine refuses a setting change', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => init?.method === 'PUT'
    ? { ok: false, status: 400, json: async () => ({ detail: 'could not restart proxy' }) }
    : { ok: true, json: async () => ({ mode: 'auto' }) }));
  render(<HttpProtocolSection />);
  const select = screen.getByRole('combobox', { name: t('httpProtocol.section') }) as HTMLSelectElement;
  await waitFor(() => expect(select.disabled).toBe(false));
  fireEvent.change(select, { target: { value: 'http2' } });
  await screen.findByText(/could not restart proxy/);
  expect(select.value).toBe('auto');
});

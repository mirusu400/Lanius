import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderWithI18n as render, t } from '../../test-utils';
import { CaptureStorageSection } from './CaptureStorageSection';

let limit: number;
let reject: boolean;
beforeEach(() => {
  limit = 5;
  reject = false;
  vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PATCH' && reject) return { ok: false, status: 422, json: async () => ({ detail: 'could not save' }) } as Response;
    if (init?.method === 'PATCH') limit = JSON.parse(String(init.body)).media_body_limit_mb;
    return { ok: true, status: 200, json: async () => ({ media_body_limit_mb: limit }) } as Response;
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('loads the 5 MB default and persists a new limit including unlimited storage', async () => {
  const user = userEvent.setup();
  const view = render(<CaptureStorageSection />);
  const input = screen.getByRole('spinbutton', { name: t('captureStorage.limit') });
  await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));
  expect(input).toHaveProperty('value', '5');
  await user.clear(input);
  await user.type(input, '2');
  await user.click(screen.getByRole('button', { name: t('captureStorage.apply') }));
  await waitFor(() => expect(limit).toBe(2));
  view.unmount();
  render(<CaptureStorageSection />);
  const restored = screen.getByRole('spinbutton', { name: t('captureStorage.limit') });
  await waitFor(() => expect(restored).toHaveProperty('value', '2'));
  await user.clear(restored);
  await user.type(restored, '0');
  await user.click(screen.getByRole('button', { name: t('captureStorage.apply') }));
  await waitFor(() => expect(limit).toBe(0));
});

it('disables invalid values and reports a failed save without changing the stored limit', async () => {
  const user = userEvent.setup();
  render(<CaptureStorageSection />);
  const input = screen.getByRole('spinbutton', { name: t('captureStorage.limit') });
  const button = screen.getByRole('button', { name: t('captureStorage.apply') });
  await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));
  await user.clear(input);
  expect(button).toHaveProperty('disabled', true);
  await user.type(input, '1025');
  expect(button).toHaveProperty('disabled', true);
  await user.clear(input);
  await user.type(input, '10');
  reject = true;
  await user.click(button);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'could not save');
  expect(limit).toBe(5);
});

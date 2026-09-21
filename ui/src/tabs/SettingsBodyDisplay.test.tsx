import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { renderWithI18n as render, t } from '../test-utils';
import { BodyDisplaySection } from './settings/BodyDisplaySection';

let enabled = true;

beforeEach(() => {
  enabled = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        enabled = JSON.parse(String(init.body)).auto_decompress;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ auto_decompress: enabled }),
      } as Response;
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('defaults to automatic decompression and persists the toggle', async () => {
  const user = userEvent.setup();
  render(<BodyDisplaySection />);
  const toggle = await screen.findByRole('checkbox', {
    name: t('bodyDisplay.autoDecompress'),
  });
  await waitFor(() => expect((toggle as HTMLInputElement).disabled).toBe(false));
  expect((toggle as HTMLInputElement).checked).toBe(true);

  await user.click(toggle);
  await waitFor(() => expect(enabled).toBe(false));
  expect((toggle as HTMLInputElement).checked).toBe(false);
});

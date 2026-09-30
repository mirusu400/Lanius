import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LockdownSection } from './settings/LockdownSection';
import { renderWithI18n as render, t } from '../test-utils';

let scopeEgress = false;
let writes: Array<{ url: string; body: unknown }> = [];

const status = () => ({
  global_enabled: false,
  project_enabled: true,
  effective: true,
  scope_egress_enabled: scopeEgress,
  scope_egress_effective: scopeEgress,
});

beforeEach(() => {
  scopeEgress = false;
  writes = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PUT' && String(url).endsWith('/api/lockdown/scope-egress')) {
        const body = JSON.parse(String(init.body)) as { enabled: boolean };
        scopeEgress = body.enabled;
        writes.push({ url: String(url), body });
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => status(),
      } as Response;
    }) as unknown as typeof fetch,
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Lockdown scope egress', () => {
  it('persists the option and shows when enforcement is effective', async () => {
    render(<LockdownSection />);
    const checkbox = await screen.findByLabelText(t('lockdown.scopeEgress'));

    await userEvent.click(checkbox);

    await waitFor(() => expect(writes).toEqual([
      {
        url: expect.stringContaining('/api/lockdown/scope-egress'),
        body: { enabled: true },
      },
    ]));
    expect(await screen.findByText(t('lockdown.scopeEgressActive'))).toBeTruthy();
  });
});

import { act, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import { engineRequestFailed } from '../engineConnection';
import { renderWithI18n as render, t } from '../test-utils';
import { EngineConnectionBanner } from './EngineConnectionBanner';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('shows one persistent outage and clears it after reconnecting', async () => {
  act(() => { engineRequestFailed(new Error('Failed to fetch')); });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })));
  render(<EngineConnectionBanner />);

  expect(screen.getByRole('alert').textContent).toContain(t('engine.connectionLost'));
  await userEvent.click(screen.getByRole('button', { name: t('engine.connectionRetry') }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
});

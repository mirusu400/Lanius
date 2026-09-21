import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { renderWithI18n as render, t } from '../test-utils';
import { MatchReplaceButton } from './MatchReplaceDialog';

let saved: unknown = null;

beforeEach(() => {
  saved = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') saved = JSON.parse(String(init.body));
      return {
        ok: true,
        status: 200,
        json: async () => saved ?? { rules: [] },
      } as Response;
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('opens, adds, and saves a shared Match & Replace rule', async () => {
  const user = userEvent.setup();
  render(<MatchReplaceButton />);
  await user.click(screen.getByRole('button', { name: t('matchReplace.button') }));
  await user.click(await screen.findByRole('button', { name: t('matchReplace.add') }));
  await user.type(screen.getByLabelText(t('matchReplace.match')), 'before');
  await user.type(screen.getByLabelText(t('matchReplace.replace')), 'after');
  await user.click(screen.getByRole('button', { name: t('matchReplace.save') }));
  await waitFor(() => expect(saved).not.toBeNull());
  expect((saved as { rules: { match: string }[] }).rules[0].match).toBe('before');
});

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { renderWithI18n as render, t } from '../test-utils';
import { MatchReplaceButton } from './MatchReplaceDialog';

let saved: unknown = null;
let previewPayload: unknown = null;

beforeEach(() => {
  saved = null;
  previewPayload = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith('/api/match-replace/preview')) {
        previewPayload = JSON.parse(String(init?.body));
        return { ok: true, status: 200, json: async () => ({ raw: 'GET /new HTTP/1.1\r\n\r\n' }) } as Response;
      }
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

it('previews unsaved whole-request rules against pasted raw HTTP', async () => {
  const user = userEvent.setup();
  render(<MatchReplaceButton />);
  await user.click(screen.getByRole('button', { name: t('matchReplace.button') }));
  await user.click(await screen.findByRole('button', { name: t('matchReplace.add') }));
  await user.selectOptions(screen.getByLabelText(t('matchReplace.target')), 'message');
  expect(screen.getByRole('option', { name: t('matchReplace.wholeRequest') })).toBeTruthy();
  await user.type(screen.getByLabelText(t('matchReplace.match')), '/old');
  await user.type(screen.getByLabelText(t('matchReplace.replace')), '/new');
  const raw = 'GET /old HTTP/1.1\nHost: example.com\n\n';
  fireEvent.change(screen.getByLabelText(t('matchReplace.rawRequest')), { target: { value: raw } });
  await user.click(screen.getByRole('button', { name: t('matchReplace.previewButton') }));
  await waitFor(() => expect(previewPayload).not.toBeNull());
  expect(previewPayload).toMatchObject({ phase: 'request', raw, rules: [{ target: 'message', match: '/old' }] });
  expect((screen.getByLabelText(t('matchReplace.previewResult')) as HTMLTextAreaElement).value).toContain('/new');
  expect(saved).toBeNull();

  await user.selectOptions(screen.getByLabelText(t('matchReplace.phase')), 'response');
  expect(screen.getByRole('option', { name: t('matchReplace.wholeResponse') })).toBeTruthy();
});

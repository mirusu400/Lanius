import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ScopeRule } from '../api/types';
import { renderWithI18n as render, t } from '../test-utils';
import { ScopeEditor } from './ScopeEditor';
import { describeRule } from '../tabs/targetModel';

const rule: ScopeRule = {
  id: 7, kind: 'exclude', host: '^(api|cdn)\\.test$', path: '^/private/.*$',
  protocol: 'https', port: 8443, match_type: 'regex', enabled: true,
};

function setup(onUpdate = vi.fn<(id: number, changes: Partial<ScopeRule>) => Promise<void>>()
  .mockResolvedValue(undefined)) {
  render(<ScopeEditor scope={{ rules: [rule], restrict_capture: true }}
    onAddUrl={vi.fn()} onUpdate={onUpdate} onDelete={vi.fn()} onRestrictCapture={vi.fn()} />);
  return { user: userEvent.setup(), onUpdate };
}

afterEach(cleanup);

describe('ScopeEditor editing', () => {
  it('opens the right-clicked rule and discards changes on cancel', async () => {
    const { user, onUpdate } = setup();
    fireEvent.contextMenu(screen.getByText(describeRule(rule)), { clientX: 30, clientY: 40 });
    await user.click(screen.getByRole('menuitem', { name: t('scope.editRule') }));
    const dialog = within(screen.getByRole('dialog', { name: t('scope.editRule') }));
    expect((dialog.getByLabelText(t('scope.hostPattern')) as HTMLInputElement).value).toBe(rule.host);
    expect((dialog.getByLabelText(t('scope.pathPattern')) as HTMLInputElement).value).toBe(rule.path);
    expect((dialog.getByLabelText(t('scope.matchType')) as HTMLSelectElement).value).toBe('regex');
    await user.clear(dialog.getByLabelText(t('scope.hostPattern')));
    await user.type(dialog.getByLabelText(t('scope.hostPattern')), 'changed');
    await user.click(dialog.getByRole('button', { name: t('common.cancel') }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onUpdate).not.toHaveBeenCalled();

    await user.dblClick(screen.getByText(describeRule(rule)));
    expect((screen.getByLabelText(t('scope.hostPattern')) as HTMLInputElement).value).toBe(rule.host);
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('keeps a rejected draft for correction and retries without changing other fields', async () => {
    const onUpdate = vi.fn<(id: number, changes: Partial<ScopeRule>) => Promise<void>>()
      .mockRejectedValueOnce(new Error('invalid regex'))
      .mockResolvedValue(undefined);
    const { user } = setup(onUpdate);
    await user.dblClick(screen.getByText(describeRule(rule)));
    const host = screen.getByLabelText(t('scope.hostPattern'));
    await user.clear(host);
    await user.type(host, '(');
    await user.click(screen.getByRole('button', { name: t('scope.saveRule') }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'invalid regex');
    expect((host as HTMLInputElement).value).toBe('(');
    expect(screen.getByText(describeRule(rule))).toBeTruthy();
    await user.clear(host);
    await user.type(host, '^updated\\.test$');
    await user.click(screen.getByRole('button', { name: t('scope.saveRule') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onUpdate.mock.calls).toEqual([[7, { host: '(' }], [7, { host: '^updated\\.test$' }]]);
  });

  it('keeps the original kind and shows an error when an inline save fails', async () => {
    const onUpdate = vi.fn<(id: number, changes: Partial<ScopeRule>) => Promise<void>>()
      .mockRejectedValue(new Error('engine unavailable'));
    const { user } = setup(onUpdate);
    const row = screen.getByText(describeRule(rule)).closest('tr')!;
    await user.dblClick(within(row).getByText(t('scope.exclude')));
    await user.selectOptions(within(row).getByRole('combobox'), 'include');
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'engine unavailable');
    expect(within(row).getByText(t('scope.exclude'))).toBeTruthy();
    expect(onUpdate).toHaveBeenCalledWith(7, { kind: 'include' });
  });

  it('supports keyboard editing and closes unchanged edits without saving', async () => {
    const { user, onUpdate } = setup();
    const cell = screen.getByText(describeRule(rule));
    cell.focus();
    await user.keyboard('{F2}');
    await user.click(screen.getByRole('button', { name: t('scope.saveRule') }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onUpdate).not.toHaveBeenCalled();

    const kindCell = screen.getByRole('cell', { name: t('scope.exclude') });
    kindCell.focus();
    await user.keyboard('{Enter}');
    expect(within(kindCell).getByRole('combobox')).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(within(kindCell).queryByRole('combobox')).toBeNull();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('waits for an in-flight save and prevents repeated submissions', async () => {
    let finish: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const onUpdate = vi.fn<(id: number, changes: Partial<ScopeRule>) => Promise<void>>()
      .mockReturnValue(pending);
    const { user } = setup(onUpdate);
    await user.dblClick(screen.getByText(describeRule(rule)));
    await user.clear(screen.getByLabelText(t('scope.port')));
    const saveButton = screen.getByRole('button', { name: t('scope.saveRule') });
    await user.dblClick(saveButton);
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(saveButton).toHaveProperty('disabled', true);
    expect(onUpdate.mock.calls).toEqual([[7, { port: null }]]);
    finish!();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

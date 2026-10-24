import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';

import { renderWithI18n as render, t } from '../test-utils';
import { CurrentProjectButton } from './CurrentProjectButton';

it('keeps the active project visible and opens its settings', async () => {
  const open = vi.fn();
  render(<CurrentProjectButton project={{
    id: 'demo', name: 'Acme audit', temporary: false,
    dbPath: '/projects/acme/lanius.sqlite', lastOpened: 0,
  }} onOpen={open} />);

  const button = screen.getByRole('button', {
    name: `${t('project.current')}: Acme audit`,
  });
  expect(button.textContent).toContain('Acme audit');
  expect(button.getAttribute('title')).toContain('/projects/acme/lanius.sqlite');
  await userEvent.click(button);
  expect(open).toHaveBeenCalledOnce();
});

it('labels a disposable workspace as temporary', () => {
  render(<CurrentProjectButton project={{
    id: 'temp', name: 'ignored', temporary: true,
    dbPath: '/tmp/lanius.sqlite', lastOpened: 0,
  }} onOpen={() => {}} />);
  expect(screen.getByRole('button', {
    name: `${t('project.current')}: ${t('startup.tempName')}`,
  })).toBeTruthy();
});

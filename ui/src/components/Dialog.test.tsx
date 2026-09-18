/** The dialog shell: how it opens, and how it gets out of the way. */
import { cleanup, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Dialog } from './Dialog';
import { renderWithI18n as render, t } from '../test-utils';

afterEach(cleanup);

describe('Dialog', () => {
  it('shows nothing until it is open', () => {
    render(
      <Dialog open={false} title="Library" onClose={() => {}}>
        <p>inside</p>
      </Dialog>,
    );
    expect((screen.getByRole('dialog', { hidden: true }) as HTMLDialogElement).open).toBe(
      false,
    );
  });

  it('opens as a modal', () => {
    render(
      <Dialog open title="Library" onClose={() => {}}>
        <p>inside</p>
      </Dialog>,
    );
    expect((screen.getByRole('dialog') as HTMLDialogElement).open).toBe(true);
    expect(screen.getByText('inside')).toBeTruthy();
  });

  it('closes on the close button', async () => {
    const onClose = vi.fn();
    render(
      <Dialog open title="Library" onClose={onClose}>
        <p>inside</p>
      </Dialog>,
    );
    await userEvent.click(screen.getByRole('button', { name: t('common.close') }));
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    // A dialog you cannot dismiss with the keyboard is worse than none.
    const onClose = vi.fn();
    render(
      <Dialog open title="Library" onClose={onClose}>
        <p>inside</p>
      </Dialog>,
    );
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    expect(onClose).toHaveBeenCalled();
  });

  it('closes when the backdrop is clicked', async () => {
    const onClose = vi.fn();
    render(
      <Dialog open title="Library" onClose={onClose}>
        <p>inside</p>
      </Dialog>,
    );
    await userEvent.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalled();
  });

  it('stays open when its contents are clicked', async () => {
    // Otherwise selecting text inside it dismisses it.
    const onClose = vi.fn();
    render(
      <Dialog open title="Library" onClose={onClose}>
        <p>inside</p>
      </Dialog>,
    );
    await userEvent.click(screen.getByText('inside'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('carries a footer when given one', () => {
    render(
      <Dialog open title="Library" onClose={() => {}} footer={<button>Use</button>}>
        <p>inside</p>
      </Dialog>,
    );
    expect(screen.getByRole('button', { name: 'Use' })).toBeTruthy();
  });

  it('is labelled for assistive tech', () => {
    render(
      <Dialog open title="Payload library" onClose={() => {}}>
        <p>inside</p>
      </Dialog>,
    );
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe(
      'Payload library',
    );
  });
});

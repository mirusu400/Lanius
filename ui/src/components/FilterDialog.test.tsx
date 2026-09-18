/** The history filter dialog. */
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FilterDialog, countActive } from './FilterDialog';
import { renderWithI18n as render, t } from '../test-utils';
import type { FlowFilters } from '../api/types';

afterEach(cleanup);

function open(filters: FlowFilters = {}) {
  const onApply = vi.fn<(f: FlowFilters) => void>();
  const onClose = vi.fn<() => void>();
  render(
    <FilterDialog open filters={filters} onClose={onClose} onApply={onApply} />,
  );
  return { onApply, onClose };
}

const apply = () => screen.getByRole('button', { name: t('filter.apply') });

/** The checkboxes under one heading. */
function group(heading: string): HTMLElement {
  return screen.getByText(heading).closest('section')!;
}

describe('FilterDialog', () => {
  it('opens as a dialog', () => {
    open();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('picks several methods at once', async () => {
    // One method at a time was the old limit, and it is not how anyone
    // looks through a capture.
    const { onApply } = open();
    const methods = group(t('filter.methods'));
    await userEvent.click(within(methods).getByLabelText('POST'));
    await userEvent.click(within(methods).getByLabelText('PUT'));
    await userEvent.click(apply());
    expect(onApply.mock.calls[0][0].methods).toEqual(['POST', 'PUT']);
  });

  it('unticks a method', async () => {
    const { onApply } = open({ methods: ['GET', 'POST'] });
    await userEvent.click(
      within(group(t('filter.methods'))).getByLabelText('GET'),
    );
    await userEvent.click(apply());
    expect(onApply.mock.calls[0][0].methods).toEqual(['POST']);
  });

  it('picks status classes', async () => {
    // 2xx is the useful unit, not 200 against 201.
    const { onApply } = open();
    const status = group(t('filter.status'));
    await userEvent.click(within(status).getByLabelText('4xx'));
    await userEvent.click(within(status).getByLabelText('5xx'));
    await userEvent.click(apply());
    expect(onApply.mock.calls[0][0].statusClasses).toEqual([4, 5]);
  });

  it('shows only chosen extensions', async () => {
    const { onApply } = open();
    await userEvent.click(
      within(group(t('filter.showOnly'))).getByLabelText('js'),
    );
    await userEvent.click(apply());
    expect(onApply.mock.calls[0][0].extensions).toEqual(['js']);
  });

  it('takes extensions that are not on the list', async () => {
    const { onApply } = open();
    await userEvent.type(
      screen.getByLabelText(t('filter.showOnlyOther')),
      'php, aspx',
    );
    await userEvent.click(apply());
    expect(onApply.mock.calls[0][0].extensions).toEqual(['php', 'aspx']);
  });

  it('ignores a leading dot on a typed extension', async () => {
    const { onApply } = open();
    await userEvent.type(screen.getByLabelText(t('filter.showOnlyOther')), '.json');
    await userEvent.click(apply());
    expect(onApply.mock.calls[0][0].extensions).toEqual(['json']);
  });

  it('hides chosen extensions', async () => {
    // The usual first move: a capture is mostly images.
    const { onApply } = open();
    await userEvent.click(within(group(t('filter.hide'))).getByLabelText('png'));
    await userEvent.click(apply());
    expect(onApply.mock.calls[0][0].excludeExtensions).toEqual(['png']);
  });

  it('hides every static type in one click', async () => {
    const { onApply } = open();
    await userEvent.click(
      screen.getByRole('button', { name: t('filter.hideAllStatic') }),
    );
    await userEvent.click(apply());
    const hidden = onApply.mock.calls[0][0].excludeExtensions ?? [];
    expect(hidden).toContain('png');
    expect(hidden).toContain('woff2');
  });

  it('filters to a host', async () => {
    const { onApply } = open();
    await userEvent.type(screen.getByLabelText(t('filter.host')), 'api.test');
    await userEvent.click(apply());
    expect(onApply.mock.calls[0][0].host).toBe('api.test');
  });

  it('filters to what is in scope', async () => {
    const { onApply } = open();
    await userEvent.click(screen.getByLabelText(t('filter.inScopeOnly')));
    await userEvent.click(apply());
    expect(onApply.mock.calls[0][0].inScopeOnly).toBe(true);
  });

  it('applies nothing until Apply is pressed', async () => {
    // Building a filter takes several clicks; reloading after each one
    // is slow and disorienting.
    const { onApply } = open();
    await userEvent.click(
      within(group(t('filter.methods'))).getByLabelText('POST'),
    );
    expect(onApply).not.toHaveBeenCalled();
  });

  it('closes after applying', async () => {
    const { onClose } = open();
    await userEvent.click(apply());
    expect(onClose).toHaveBeenCalled();
  });

  it('throws the draft away on cancel', async () => {
    const { onApply, onClose } = open();
    await userEvent.click(
      within(group(t('filter.methods'))).getByLabelText('POST'),
    );
    await userEvent.click(screen.getByRole('button', { name: t('common.cancel') }));
    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('starts from the filters already in force', () => {
    open({ methods: ['POST'], inScopeOnly: true });
    const methods = group(t('filter.methods'));
    expect((within(methods).getByLabelText('POST') as HTMLInputElement).checked).toBe(
      true,
    );
    expect(
      (screen.getByLabelText(t('filter.inScopeOnly')) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it('resets everything but the search box', async () => {
    // The search is typed in the bar; clearing it from in here would be
    // a surprise.
    const { onApply } = open({ methods: ['POST'], search: 'admin' });
    await userEvent.click(screen.getByRole('button', { name: t('filter.reset') }));
    await userEvent.click(apply());
    expect(onApply.mock.calls[0][0]).toEqual({ search: 'admin' });
  });
});

describe('countActive', () => {
  it('is zero when nothing is filtered', () => {
    expect(countActive({})).toBe(0);
  });

  it('does not count the free-text search', () => {
    // It has its own box in the bar, where it is already visible.
    expect(countActive({ search: 'admin' })).toBe(0);
  });

  it('counts each kind once, however many boxes are ticked', () => {
    expect(countActive({ methods: ['GET', 'POST', 'PUT'] })).toBe(1);
  });

  it('adds up different kinds', () => {
    expect(
      countActive({ methods: ['GET'], statusClasses: [2], inScopeOnly: true }),
    ).toBe(3);
  });

  it('ignores an empty list', () => {
    expect(countActive({ methods: [], extensions: [] })).toBe(0);
  });
});

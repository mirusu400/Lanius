/** Tests for the copy-as menu shared by Repeater, Intruder and history. */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ContextMenu, type MenuItem } from './ContextMenu';
import { useCodegenMenu } from './useCodegenMenu';
import { renderWithI18n, t } from '../test-utils';

vi.mock('../api/client', () => ({
  listCodegenFormats: vi.fn(),
  renderCode: vi.fn(),
}));

const api = await import('../api/client');

function Harness({ target }: { target: Parameters<ReturnType<typeof useCodegenMenu>['buildMenu']>[0] }) {
  const { buildMenu } = useCodegenMenu();
  return (
    <ContextMenu
      position={{ x: 0, y: 0 }}
      items={[buildMenu(target)]}
      onClose={() => undefined}
    />
  );
}

describe('useCodegenMenu', () => {
  beforeEach(() => {
    vi.mocked(api.listCodegenFormats).mockResolvedValue({
      formats: [
        { kind: 'curl', label: 'curl', source: 'builtin' },
        { kind: 'python-redacted', label: 'Python (redacted)', source: 'my_plugin' },
      ],
    });
    vi.mocked(api.renderCode).mockResolvedValue({ kind: 'curl', text: 'curl x' });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('asks the engine which formats to offer, so plugins appear', async () => {
    renderWithI18n(<Harness target={{ flow_id: 'f1' }} />);
    await userEvent.hover(screen.getByRole('menuitem', { name: t('menu.copyAs') }));
    await waitFor(() =>
      expect(screen.getByRole('menuitem', { name: /Python \(redacted\)/ })).toBeTruthy(),
    );
  });

  it('marks which plugin a contributed format came from', async () => {
    renderWithI18n(<Harness target={{ flow_id: 'f1' }} />);
    await userEvent.hover(screen.getByRole('menuitem', { name: t('menu.copyAs') }));
    await waitFor(() =>
      expect(screen.getByText(/my_plugin/)).toBeTruthy(),
    );
  });

  it('renders the request server-side and copies the result', async () => {
    renderWithI18n(<Harness target={{ flow_id: 'f1' }} />);
    await userEvent.hover(screen.getByRole('menuitem', { name: t('menu.copyAs') }));
    const item = await screen.findByRole('menuitem', { name: 'curl' });
    await userEvent.click(item);
    await waitFor(() =>
      expect(api.renderCode).toHaveBeenCalledWith({ kind: 'curl', flow_id: 'f1' }),
    );
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('curl x'),
    );
  });

  it('is disabled when the request cannot be parsed', async () => {
    renderWithI18n(<Harness target={null} />);
    const entry = screen.getByRole('menuitem', { name: t('menu.copyAs') });
    expect((entry as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps the built-in formats when the listing fails', async () => {
    vi.mocked(api.listCodegenFormats).mockRejectedValue(new Error('offline'));
    renderWithI18n(<Harness target={{ flow_id: 'f1' }} />);
    await userEvent.hover(screen.getByRole('menuitem', { name: t('menu.copyAs') }));
    expect(await screen.findByRole('menuitem', { name: 'curl' })).toBeTruthy();
  });
});

describe('ContextMenu submenus', () => {
  afterEach(cleanup);

  it('does not show nested items until the parent is opened', async () => {
    const items: MenuItem[] = [
      { label: 'Copy as', items: [{ label: 'curl' }] },
    ];
    render(
      <ContextMenu position={{ x: 0, y: 0 }} items={items} onClose={() => undefined} />,
    );
    expect(screen.queryByRole('menuitem', { name: 'curl' })).toBeNull();
    await userEvent.hover(screen.getByRole('menuitem', { name: 'Copy as' }));
    expect(screen.getByRole('menuitem', { name: 'curl' })).toBeTruthy();
  });

  it('closes the whole menu once a nested item is chosen', async () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    const items: MenuItem[] = [
      { label: 'Copy as', items: [{ label: 'curl', onSelect }] },
    ];
    render(<ContextMenu position={{ x: 0, y: 0 }} items={items} onClose={onClose} />);
    await userEvent.hover(screen.getByRole('menuitem', { name: 'Copy as' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'curl' }));
    expect(onSelect).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('a parent row does not act as a command of its own', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const items: MenuItem[] = [
      { label: 'Copy as', onSelect, items: [{ label: 'curl' }] },
    ];
    render(<ContextMenu position={{ x: 0, y: 0 }} items={items} onClose={onClose} />);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Copy as' }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

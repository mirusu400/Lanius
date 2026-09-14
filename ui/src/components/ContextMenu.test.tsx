/** Right-click menus. */
import { cleanup, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ContextMenu } from './ContextMenu';
import { renderWithI18n as render } from '../test-utils';

afterEach(cleanup);

const items = [
  { label: 'Send to Repeater', onSelect: vi.fn() },
  { label: 'Copy URL', onSelect: vi.fn() },
];

describe('ContextMenu', () => {
  it('renders nothing when closed', () => {
    render(<ContextMenu position={null} items={items} onClose={vi.fn()} />);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('renders nothing when there is nothing to offer', () => {
    // An empty menu on right-click looks like a bug.
    render(<ContextMenu position={{ x: 10, y: 10 }} items={[]} onClose={vi.fn()} />);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('shows its items', () => {
    render(<ContextMenu position={{ x: 10, y: 10 }} items={items} onClose={vi.fn()} />);
    expect(screen.getAllByRole('menuitem')).toHaveLength(2);
  });

  it('runs the action and closes', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <ContextMenu
        position={{ x: 10, y: 10 }}
        items={[{ label: 'Do it', onSelect }]}
        onClose={onClose}
      />,
    );

    await userEvent.click(screen.getByRole('menuitem', { name: 'Do it' }));
    expect(onSelect).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('does not run a disabled item', async () => {
    const onSelect = vi.fn();
    render(
      <ContextMenu
        position={{ x: 10, y: 10 }}
        items={[{ label: 'Nope', onSelect, disabled: true }]}
        onClose={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('menuitem', { name: 'Nope' }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<ContextMenu position={{ x: 10, y: 10 }} items={items} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('closes when you click elsewhere', () => {
    const onClose = vi.fn();
    render(<ContextMenu position={{ x: 10, y: 10 }} items={items} onClose={onClose} />);
    fireEvent.mouseDown(window);
    expect(onClose).toHaveBeenCalled();
  });

  it('stays open while you move onto it', () => {
    const onClose = vi.fn();
    render(<ContextMenu position={{ x: 10, y: 10 }} items={items} onClose={onClose} />);
    fireEvent.mouseDown(screen.getByRole('menu'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('flips rather than opening off-screen', () => {
    // jsdom reports zero-sized boxes, so drive the measurement directly.
    const width = 200;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width,
      height: 100,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: width,
      bottom: 100,
      toJSON: () => ({}),
    } as DOMRect);

    render(
      <ContextMenu
        position={{ x: window.innerWidth - 10, y: 10 }}
        items={items}
        onClose={vi.fn()}
      />,
    );

    const menu = screen.getByRole('menu') as HTMLElement;
    expect(parseFloat(menu.style.left)).toBeLessThan(window.innerWidth - 10);
    vi.restoreAllMocks();
  });
});

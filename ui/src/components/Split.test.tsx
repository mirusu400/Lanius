/** Draggable pane divider. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Split } from './Split';

function renderSplit(props: Partial<React.ComponentProps<typeof Split>> = {}) {
  return render(
    <Split
      direction="horizontal"
      storageKey="test.split"
      first={<div>left</div>}
      second={<div>right</div>}
      {...props}
    />,
  );
}

/** The handle sizes the first pane, so its flex-basis is the position. */
function position(): number {
  const pane = document.querySelector('.split-pane') as HTMLElement;
  return Number.parseFloat(pane.style.flexBasis);
}

function dragTo(clientX: number) {
  const handle = screen.getByRole('separator');
  // A real container has a size; jsdom reports zero unless it is told.
  const container = handle.parentElement as HTMLElement;
  container.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 1000, height: 500 }) as DOMRect;
  fireEvent.mouseDown(handle);
  fireEvent.mouseMove(window, { clientX, clientY: clientX / 2 });
  fireEvent.mouseUp(window);
}

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe('Split', () => {
  it('starts at the requested fraction', () => {
    renderSplit({ initial: 0.6 });
    expect(position()).toBeCloseTo(60);
  });

  it('moves when the handle is dragged', () => {
    renderSplit({ initial: 0.5 });
    dragTo(300);
    expect(position()).toBeCloseTo(30);
  });

  it('keeps both panes usable at the extremes', () => {
    // A divider that can be dragged off the edge hides a pane with no
    // way to get it back.
    renderSplit();
    dragTo(5);
    expect(position()).toBeGreaterThanOrEqual(15);
    dragTo(995);
    expect(position()).toBeLessThanOrEqual(85);
  });

  it('remembers the position', () => {
    renderSplit({ initial: 0.5 });
    dragTo(300);
    cleanup();
    renderSplit({ initial: 0.5 });
    expect(position()).toBeCloseTo(30);
  });

  it('ignores a stored value that would collapse a pane', () => {
    window.localStorage.setItem('test.split', '0.99');
    renderSplit();
    expect(position()).toBeLessThanOrEqual(85);
  });

  it('ignores a stored value that is not a number', () => {
    window.localStorage.setItem('test.split', 'wat');
    renderSplit({ initial: 0.4 });
    expect(position()).toBeCloseTo(40);
  });

  it('can be moved from the keyboard', () => {
    // Drag-only controls are unreachable without a mouse.
    renderSplit({ initial: 0.5 });
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowRight' });
    expect(position()).toBeGreaterThan(50);
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowLeft' });
    expect(position()).toBeCloseTo(50);
  });

  it('resets to the default on double click', () => {
    renderSplit({ initial: 0.5 });
    dragTo(200);
    fireEvent.doubleClick(screen.getByRole('separator'));
    expect(position()).toBeCloseTo(50);
  });

  it('stops tracking the pointer after the button is released', () => {
    renderSplit({ initial: 0.5 });
    dragTo(300);
    fireEvent.mouseMove(window, { clientX: 900 });
    expect(position()).toBeCloseTo(30);
  });

  it('reports its position for assistive tech', () => {
    renderSplit({ initial: 0.5 });
    const handle = screen.getByRole('separator');
    expect(handle.getAttribute('aria-valuenow')).toBe('50');
    expect(handle.getAttribute('aria-orientation')).toBe('vertical');
  });

  it('keeps two independent splits apart', () => {
    // The proxy and detail dividers must not share a position.
    renderSplit({ storageKey: 'a', initial: 0.5 });
    dragTo(300);
    cleanup();
    renderSplit({ storageKey: 'b', initial: 0.5 });
    expect(position()).toBeCloseTo(50);
  });
});

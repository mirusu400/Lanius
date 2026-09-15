/** A pane divider the user can drag.
 *
 * The proxy view guesses wrong for everyone: a long URL wants a wide
 * table, reading a body wants a wide detail. Rather than pick a ratio,
 * let it be moved, and remember where it was put.
 *
 * Sizes are kept as a fraction rather than pixels so the layout still
 * makes sense after the window is resized.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const MIN_FRACTION = 0.15;
const MAX_FRACTION = 0.85;

function clamp(value: number): number {
  return Math.min(MAX_FRACTION, Math.max(MIN_FRACTION, value));
}

function load(key: string, fallback: number): number {
  if (typeof window === 'undefined') return fallback;
  const stored = window.localStorage?.getItem(key);
  if (!stored) return fallback;
  const parsed = Number.parseFloat(stored);
  // A stored value from a previous version, or a hand-edited one, should
  // not be able to collapse a pane to nothing.
  return Number.isFinite(parsed) ? clamp(parsed) : fallback;
}

export function Split({
  direction,
  storageKey,
  initial = 0.5,
  first,
  second,
  className,
}: {
  direction: 'horizontal' | 'vertical';
  /** Where to remember the position. */
  storageKey: string;
  initial?: number;
  first: React.ReactNode;
  second: React.ReactNode;
  className?: string;
}) {
  const [fraction, setFraction] = useState(() => load(storageKey, initial));
  const [dragging, setDragging] = useState(false);
  const container = useRef<HTMLDivElement | null>(null);
  const isRow = direction === 'horizontal';

  useEffect(() => {
    if (!dragging) return;

    const onMove = (event: MouseEvent) => {
      const box = container.current?.getBoundingClientRect();
      if (!box) return;
      const next = isRow
        ? (event.clientX - box.left) / box.width
        : (event.clientY - box.top) / box.height;
      setFraction(clamp(next));
    };
    const stop = () => setDragging(false);

    // On the window, not the handle: the pointer routinely runs ahead of
    // a drag, and listening on the handle alone drops it the moment that
    // happens.
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', stop);
    // A drag over a text pane would otherwise select its contents.
    const previous = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', stop);
      document.body.style.userSelect = previous;
    };
  }, [dragging, isRow]);

  useEffect(() => {
    window.localStorage?.setItem(storageKey, String(fraction));
  }, [fraction, storageKey]);

  // Keyboard, because a divider that can only be dragged is unreachable
  // for anyone not using a mouse.
  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    const step = event.shiftKey ? 0.1 : 0.02;
    const back = isRow ? 'ArrowLeft' : 'ArrowUp';
    const forward = isRow ? 'ArrowRight' : 'ArrowDown';
    if (event.key === back) setFraction((f) => clamp(f - step));
    else if (event.key === forward) setFraction((f) => clamp(f + step));
    else if (event.key === 'Home') setFraction(MIN_FRACTION);
    else if (event.key === 'End') setFraction(MAX_FRACTION);
    else return;
    event.preventDefault();
  }, [isRow]);

  const classes = ['split', isRow ? 'split-h' : 'split-v', className]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} ref={container}>
      <div className="split-pane" style={{ flexBasis: `${fraction * 100}%` }}>
        {first}
      </div>
      <div
        className={dragging ? 'split-handle dragging' : 'split-handle'}
        role="separator"
        tabIndex={0}
        aria-orientation={isRow ? 'vertical' : 'horizontal'}
        aria-valuenow={Math.round(fraction * 100)}
        aria-valuemin={Math.round(MIN_FRACTION * 100)}
        aria-valuemax={Math.round(MAX_FRACTION * 100)}
        onMouseDown={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDoubleClick={() => setFraction(initial)}
        onKeyDown={onKeyDown}
      />
      <div className="split-pane">{second}</div>
    </div>
  );
}

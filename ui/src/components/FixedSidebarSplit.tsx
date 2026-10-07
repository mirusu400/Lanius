/** A draggable sidebar whose width stays in pixels when the window changes size. */

import { useEffect, useRef, useState } from 'react';

const DEFAULT_WIDTH = 300;
const MIN_WIDTH = 180;
const MAX_WIDTH = 600;

function clamp(width: number, containerWidth?: number): number {
  const available = containerWidth ? Math.max(MIN_WIDTH, containerWidth - 220) : MAX_WIDTH;
  return Math.min(MAX_WIDTH, available, Math.max(MIN_WIDTH, width));
}

function savedWidth(storageKey: string): number {
  const value = Number(window.localStorage?.getItem(storageKey));
  return Number.isFinite(value) && value > 0 ? clamp(value) : DEFAULT_WIDTH;
}

export function FixedSidebarSplit({
  storageKey,
  label,
  sidebar,
  content,
  className,
}: {
  storageKey: string;
  label: string;
  sidebar: React.ReactNode;
  content: React.ReactNode;
  className?: string;
}) {
  const [width, setWidth] = useState(() => savedWidth(storageKey));
  const [dragging, setDragging] = useState(false);
  const container = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    window.localStorage?.setItem(storageKey, String(width));
  }, [storageKey, width]);

  useEffect(() => {
    if (!dragging) return;
    const move = (event: MouseEvent) => {
      const box = container.current?.getBoundingClientRect();
      if (box) setWidth(clamp(event.clientX - box.left, box.width));
    };
    const stop = () => setDragging(false);
    const previous = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', stop);
    return () => {
      document.body.style.userSelect = previous;
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', stop);
    };
  }, [dragging]);

  const resizeByKey = (event: React.KeyboardEvent) => {
    const step = event.shiftKey ? 40 : 16;
    if (event.key === 'ArrowLeft') setWidth((current) => clamp(current - step, container.current?.clientWidth));
    else if (event.key === 'ArrowRight') setWidth((current) => clamp(current + step, container.current?.clientWidth));
    else if (event.key === 'Home') setWidth(MIN_WIDTH);
    else if (event.key === 'End') setWidth(clamp(MAX_WIDTH, container.current?.clientWidth));
    else return;
    event.preventDefault();
  };

  return (
    <div ref={container} className={`split split-h ${className ?? ''}`}>
      <div className="split-pane fixed-sidebar" style={{ flex: `0 1 ${width}px` }}>
        {sidebar}
      </div>
      <div
        className={dragging ? 'split-handle dragging' : 'split-handle'}
        role="separator"
        tabIndex={0}
        aria-label={label}
        aria-orientation="vertical"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        aria-valuenow={width}
        onMouseDown={(event) => { event.preventDefault(); setDragging(true); }}
        onDoubleClick={() => setWidth(DEFAULT_WIDTH)}
        onKeyDown={resizeByKey}
      />
      <div className="split-pane">{content}</div>
    </div>
  );
}

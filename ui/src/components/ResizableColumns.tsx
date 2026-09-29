/** Shared, persistent column widths for data tables. */

import { useEffect, useRef, useState } from 'react';

const MIN_WIDTH = 48;
const MAX_WIDTH = 2000;

function clamp(width: number): number {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(width)));
}

function loadWidths(key: string, defaults: number[]): number[] {
  try {
    const saved = JSON.parse(window.localStorage.getItem(key) ?? 'null');
    if (Array.isArray(saved) && saved.length === defaults.length && saved.every((width) => typeof width === 'number' && Number.isFinite(width))) {
      return saved.map(clamp);
    }
  } catch {
    // Storage may be disabled, or may contain a value from an older layout.
  }
  return defaults;
}

export function useResizableColumns(key: string, defaults: number[]) {
  const [widths, setWidths] = useState(() => loadWidths(key, defaults));
  const [drag, setDrag] = useState<{ index: number; x: number; width: number; pointerId: number } | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(widths));
    } catch {
      // Resizing still works in a session without persistent storage.
    }
  }, [key, widths]);

  useEffect(() => {
    if (!drag) return;
    const move = (event: PointerEvent) => {
      if (event.pointerId !== drag.pointerId) return;
      setWidths((current) => current.map((width, index) => index === drag.index ? clamp(drag.width + event.clientX - drag.x) : width));
    };
    const stop = (event: PointerEvent) => {
      if (event.pointerId === drag.pointerId) setDrag(null);
    };
    const previous = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      document.body.style.userSelect = previous;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, [drag]);

  const start = (event: React.PointerEvent, index: number) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ index, x: event.clientX, width: widths[index], pointerId: event.pointerId });
  };

  const step = (event: React.KeyboardEvent, index: number) => {
    const delta = event.shiftKey ? 40 : 10;
    const amount = event.key === 'ArrowLeft' ? -delta : event.key === 'ArrowRight' ? delta : 0;
    if (amount === 0) return;
    event.preventDefault();
    setWidths((current) => current.map((width, at) => at === index ? clamp(width + amount) : width));
  };

  return { widths, start, step, dragging: drag?.index ?? null };
}

type ResizableColumns = ReturnType<typeof useResizableColumns>;

export function ResizableTable({
  columns,
  className,
  children,
}: {
  columns: ResizableColumns;
  className: string;
  children: React.ReactNode;
}) {
  const table = useRef<HTMLTableElement | null>(null);
  const [available, setAvailable] = useState(0);

  useEffect(() => {
    const parent = table.current?.parentElement;
    if (!parent) return;
    const update = () => setAvailable(parent.clientWidth);
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  const total = columns.widths.reduce((sum, width) => sum + width, 0);
  const fill = Math.max(0, available - total);
  return (
    <table ref={table} className={`${className} resizable-table`} style={{ width: `${total + fill}px` }}>
      <colgroup>
        {columns.widths.map((width, index) => <col key={index} style={{ width }} />)}
        <col style={{ width: fill }} />
      </colgroup>
      {children}
    </table>
  );
}

export function ResizableFillHeader() {
  return <th className="column-fill" aria-hidden="true" />;
}

export function ResizableFillCell() {
  return <td className="column-fill" aria-hidden="true" />;
}

export function ResizableHeader({
  label,
  index,
  columns,
  className,
  resizeLabel,
}: {
  label: string;
  index: number;
  columns: ResizableColumns;
  className?: string;
  resizeLabel: string;
}) {
  return (
    <th className={className} scope="col">
      {label}
      <span
        className={columns.dragging === index ? 'column-resize-handle dragging' : 'column-resize-handle'}
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label={resizeLabel}
        aria-valuenow={columns.widths[index]}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        onPointerDown={(event) => columns.start(event, index)}
        onKeyDown={(event) => columns.step(event, index)}
      />
    </th>
  );
}

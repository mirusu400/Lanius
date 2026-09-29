/** Shared, persistent column widths for data tables. */

import { useEffect, useState } from 'react';

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
  const [drag, setDrag] = useState<{ index: number; x: number; width: number } | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(widths));
    } catch {
      // Resizing still works in a session without persistent storage.
    }
  }, [key, widths]);

  useEffect(() => {
    if (!drag) return;
    const move = (event: MouseEvent) => {
      setWidths((current) => current.map((width, index) => index === drag.index ? clamp(drag.width + event.clientX - drag.x) : width));
    };
    const stop = () => setDrag(null);
    const previous = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', stop);
    return () => {
      document.body.style.userSelect = previous;
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', stop);
    };
  }, [drag]);

  const start = (event: React.MouseEvent, index: number) => {
    event.preventDefault();
    event.stopPropagation();
    setDrag({ index, x: event.clientX, width: widths[index] });
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
        onMouseDown={(event) => columns.start(event, index)}
        onKeyDown={(event) => columns.step(event, index)}
      />
    </th>
  );
}

/** Shared, persistent column widths, order and visibility for data tables. */

import {
  Children,
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

import { ContextMenu, type MenuPosition } from './ContextMenu';

const MIN_WIDTH = 48;
const MAX_WIDTH = 2000;

function clamp(width: number): number {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(width)));
}

function loadWidths(key: string, defaults: number[]): number[] {
  try {
    const saved = JSON.parse(window.localStorage.getItem(key) ?? 'null');
    if (Array.isArray(saved) && saved.length <= defaults.length && saved.every((width) => typeof width === 'number' && Number.isFinite(width))) {
      return [...saved.map(clamp), ...defaults.slice(saved.length)];
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

  return { key, widths, start, step, dragging: drag?.index ?? null };
}

type ResizableColumns = ReturnType<typeof useResizableColumns>;

interface ColumnLayout {
  order: number[];
  hidden: number[];
}

function naturalOrder(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

function normalizeLayout(value: unknown, count: number): ColumnLayout {
  const valid = (item: unknown): item is number =>
    Number.isInteger(item) && (item as number) >= 0 && (item as number) < count;
  const saved = value && typeof value === 'object' ? value as Partial<ColumnLayout> : {};
  const order = Array.isArray(saved.order)
    ? [...new Set(saved.order.filter(valid))]
    : [];
  for (const index of naturalOrder(count)) {
    if (!order.includes(index)) order.push(index);
  }
  const hidden = Array.isArray(saved.hidden)
    ? [...new Set(saved.hidden.filter(valid))]
    : [];
  // A table with no visible columns is impossible to recover from without
  // clearing storage, so always keep one column on screen.
  if (hidden.length >= count) hidden.splice(hidden.indexOf(order[0]), 1);
  return { order, hidden };
}

function loadLayout(key: string, count: number, defaultHidden: number[]): ColumnLayout {
  let saved: unknown;
  try {
    saved = JSON.parse(window.localStorage.getItem(key) ?? 'null');
  } catch {
    // Fall back to the default layout when storage is unavailable.
  }
  const layout = normalizeLayout(saved, count);
  const order = (saved as Partial<ColumnLayout> | null)?.order;
  const previousOrder = Array.isArray(order) ? order : [];
  // New optional columns stay hidden when upgrading an existing layout, too.
  return normalizeLayout({ ...layout, hidden: [...layout.hidden,
    ...defaultHidden.filter((index) => !previousOrder.includes(index))] }, count);
}

function sameLayout(left: ColumnLayout, right: ColumnLayout): boolean {
  return left.order.join(',') === right.order.join(',')
    && left.hidden.join(',') === right.hidden.join(',');
}

interface HeaderProps {
  label: string;
  menuLabel?: string;
  index: number;
  columns: ResizableColumns;
  className?: string;
  resizeLabel: string;
  onSort?: () => void;
  sortDirection?: 'ascending' | 'descending';
  reorderable?: boolean;
  reordering?: boolean;
  dropPosition?: 'before' | 'after';
  onContextMenu?: React.MouseEventHandler<HTMLTableCellElement>;
}

interface ColumnReorder {
  source: number;
  target: number;
  position: 'before' | 'after';
}

function elements(children: ReactNode): ReactElement[] {
  return Children.toArray(children).filter(isValidElement) as ReactElement[];
}

function rowWithCells(row: ReactElement, cells: ReactNode[]): ReactElement {
  return cloneElement(row, undefined, cells);
}

export function ResizableTable({
  columns,
  className,
  children,
  defaultHidden = [],
  onHiddenChange,
}: {
  columns: ResizableColumns;
  className: string;
  children: React.ReactNode;
  defaultHidden?: number[];
  onHiddenChange?: (hidden: number[]) => void;
}) {
  const table = useRef<HTMLTableElement | null>(null);
  const [available, setAvailable] = useState(0);
  const [menu, setMenu] = useState<MenuPosition | null>(null);
  const [reorder, setReorder] = useState<ColumnReorder | null>(null);
  const [pointerDrag, setPointerDrag] = useState<{
    source: number; x: number; y: number; pointerId: number; key: string;
  } | null>(null);
  const suppressSortClick = useRef(false);
  const count = columns.widths.length;
  const layoutKey = `${columns.key}.layout`;
  const activeReorder = pointerDrag?.key === layoutKey ? reorder : null;
  const [layoutState, setLayoutState] = useState(() => ({
    key: layoutKey,
    value: loadLayout(layoutKey, count, defaultHidden),
  }));
  const loadedLayout = layoutState.key === layoutKey
    ? layoutState.value
    : loadLayout(layoutKey, count, defaultHidden);
  const normalizedLayout = normalizeLayout(loadedLayout, count);
  const layout = sameLayout(loadedLayout, normalizedLayout)
    ? loadedLayout
    : normalizedLayout;

  const saveLayout = useCallback((next: ColumnLayout) => {
    const normalized = normalizeLayout(next, count);
    try {
      window.localStorage.setItem(layoutKey, JSON.stringify(normalized));
    } catch {
      // Reordering and hiding still work in this session without persistence.
    }
    setLayoutState({ key: layoutKey, value: normalized });
  }, [layoutKey, count]);

  // Native HTML drag events are not consistently delivered by desktop
  // webviews. Track the pointer so dragging also works from a sort button.
  useEffect(() => {
    if (!pointerDrag || pointerDrag.key !== layoutKey) return;
    let active = false;
    let drop: ColumnReorder | null = null;
    const previous = document.body.style.userSelect;
    const move = (event: PointerEvent) => {
      if (event.pointerId !== pointerDrag.pointerId) return;
      if (!active && Math.hypot(event.clientX - pointerDrag.x, event.clientY - pointerDrag.y) < 5) return;
      active = true;
      suppressSortClick.current = true;
      event.preventDefault();
      document.body.style.userSelect = 'none';
      drop = null;
      for (const header of table.current?.querySelectorAll<HTMLTableCellElement>('thead th[data-column-index]') ?? []) {
        const box = header.getBoundingClientRect();
        if (event.clientX >= box.left && event.clientX <= box.right
          && event.clientY >= box.top && event.clientY <= box.bottom) {
          drop = {
            source: pointerDrag.source,
            target: Number(header.dataset.columnIndex),
            position: event.clientX > box.left + box.width / 2 ? 'after' : 'before',
          };
          break;
        }
      }
      setReorder(drop ?? { source: pointerDrag.source, target: pointerDrag.source, position: 'before' });
    };
    const finish = (apply: boolean) => {
      if (apply && drop && drop.source !== drop.target) {
        const { source, target, position } = drop;
        const order = layout.order.filter((index) => index !== source);
        order.splice(order.indexOf(target) + (position === 'after' ? 1 : 0), 0, source);
        saveLayout({ ...layout, order });
      }
      setPointerDrag(null);
      setReorder(null);
    };
    const stop = (event: PointerEvent) => {
      if (event.pointerId === pointerDrag.pointerId) finish(event.type === 'pointerup');
    };
    const cancel = () => finish(false);
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel(); };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', key);
    return () => {
      document.body.style.userSelect = previous;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', key);
    };
  }, [pointerDrag, layoutKey, layout, saveLayout]);

  const visible = layout.order.filter((index) => !layout.hidden.includes(index));
  const hiddenKey = layout.hidden.join(',');
  useEffect(() => {
    onHiddenChange?.(hiddenKey ? hiddenKey.split(',').map(Number) : []);
  }, [onHiddenChange, hiddenKey]);

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

  const total = visible.reduce((sum, index) => sum + columns.widths[index], 0);
  const fill = Math.max(0, available - total);

  const sections = elements(children);
  const head = sections.find((section) => section.type === 'thead');
  const headRow = head ? elements((head.props as { children?: ReactNode }).children)[0] : undefined;
  const originalHeaders = headRow
    ? elements((headRow.props as { children?: ReactNode }).children).slice(0, count)
    : [];

  const headerCell = (cell: ReactElement, index: number) => {
    const props = cell.props as HeaderProps;
    return cloneElement(cell as ReactElement<HeaderProps>, {
      key: cell.key ?? `column-${index}`,
      reorderable: true,
      reordering: activeReorder?.source === index,
      dropPosition: activeReorder?.target === index && activeReorder.source !== index
        ? activeReorder.position
        : undefined,
      onContextMenu: (event) => {
        event.preventDefault();
        event.stopPropagation();
        setMenu({ x: event.clientX, y: event.clientY });
      },
      // Retain a caller-supplied menu label for the checkbox list.
      menuLabel: props.menuLabel,
    });
  };

  const transformed = sections.map((section) => {
    const rows = elements((section.props as { children?: ReactNode }).children);
    if (section.type === 'thead') {
      return cloneElement(section, { key: section.key ?? 'head' }, rows.map((row, rowIndex) => {
        if (rowIndex !== 0) return row;
        const cells = elements((row.props as { children?: ReactNode }).children);
        const ordered = visible.map((index) => headerCell(cells[index], index));
        return rowWithCells(row, [...ordered, ...cells.slice(count)]);
      }));
    }
    if (section.type !== 'tbody') return section;
    return cloneElement(section, { key: section.key ?? 'body' }, rows.map((row) => {
      const cells = elements((row.props as { children?: ReactNode }).children);
      // Ordinary rows have one cell per column plus the flexible fill cell.
      // Empty-state rows instead have one spanning cell plus the fill cell.
      const firstProps = cells[0]?.props as { colSpan?: number } | undefined;
      if (firstProps?.colSpan !== undefined || cells.length < count + 1) {
        const first = cells[0];
        if (!first) return row;
        return rowWithCells(row, [
          cloneElement(first as ReactElement<{ colSpan?: number }>, { colSpan: visible.length }),
          ...cells.slice(1),
        ]);
      }
      return rowWithCells(row, [
        ...visible.map((index) => cells[index]),
        ...cells.slice(count),
      ]);
    }));
  });

  const menuItems = layout.order.map((index) => {
    const props = originalHeaders[index]?.props as HeaderProps | undefined;
    const shown = !layout.hidden.includes(index);
    return {
      label: props?.menuLabel ?? props?.label ?? `Column ${index + 1}`,
      checked: shown,
      disabled: shown && visible.length === 1,
      onSelect: () => saveLayout({
        ...layout,
        hidden: shown
          ? [...layout.hidden, index]
          : layout.hidden.filter((hidden) => hidden !== index),
      }),
    };
  });

  return <>
    <table
      ref={table}
      className={`${className} resizable-table`}
      style={{ width: `${total + fill}px` }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        suppressSortClick.current = false;
        const target = event.target as HTMLElement;
        const header = target.closest<HTMLTableCellElement>('thead th[data-column-index]');
        if (!header || target.closest('.column-resize-handle')) return;
        setMenu(null);
        setPointerDrag({ source: Number(header.dataset.columnIndex), x: event.clientX, y: event.clientY, pointerId: event.pointerId, key: layoutKey });
      }}
      onClickCapture={(event) => {
        if (suppressSortClick.current && event.detail > 0) {
          event.preventDefault();
          event.stopPropagation();
          suppressSortClick.current = false;
        }
      }}
    >
      <colgroup>
        {visible.map((index) => <col key={index} style={{ width: columns.widths[index] }} />)}
        <col style={{ width: fill }} />
      </colgroup>
      {transformed}
    </table>
    <ContextMenu
      position={menu}
      items={menu ? menuItems : []}
      onClose={() => setMenu(null)}
    />
  </>;
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
  onSort,
  sortDirection,
  reorderable,
  reordering,
  dropPosition,
  onContextMenu,
}: HeaderProps) {
  const classes = [
    className,
    reorderable ? 'column-reorderable' : '',
    reordering ? 'column-reordering' : '',
    dropPosition ? `column-drop-${dropPosition}` : '',
  ].filter(Boolean).join(' ') || undefined;
  return (
    <th
      className={classes}
      scope="col"
      aria-sort={sortDirection}
      data-column-index={index}
      onContextMenu={onContextMenu}
      onDragStart={(event) => event.preventDefault()}
    >
      {onSort ? <button type="button" className="column-sort" onClick={onSort}>
        {label}{sortDirection && <span aria-hidden="true">{sortDirection === 'ascending' ? ' ▲' : ' ▼'}</span>}
      </button> : label}
      <span
        className={columns.dragging === index ? 'column-resize-handle dragging' : 'column-resize-handle'}
        role="separator"
        tabIndex={0}
        draggable={false}
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

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/** Right-click menus, the way Burp uses them.
 *
 * A menu that opens off the edge of the window is worse than none, so it
 * measures itself and flips before painting.
 */

export interface MenuItem {
  label: string;
  onSelect?: () => void;
  disabled?: boolean;
  /** Draws a divider above this item. */
  separator?: boolean;
}

export interface MenuPosition {
  x: number;
  y: number;
}

export function ContextMenu({
  position,
  items,
  onClose,
}: {
  position: MenuPosition | null;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [placed, setPlaced] = useState<MenuPosition | null>(null);

  useLayoutEffect(() => {
    if (!position || !ref.current) {
      setPlaced(null);
      return;
    }
    const box = ref.current.getBoundingClientRect();
    // Flip rather than clamp: a menu pinned to the edge covers the row
    // that was right-clicked.
    const x =
      position.x + box.width > window.innerWidth
        ? Math.max(0, position.x - box.width)
        : position.x;
    const y =
      position.y + box.height > window.innerHeight
        ? Math.max(0, position.y - box.height)
        : position.y;
    setPlaced({ x, y });
  }, [position]);

  useEffect(() => {
    if (!position) return;
    const dismiss = () => onClose();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    // Capture phase, so a click lands on the menu item first but anything
    // else closes immediately.
    window.addEventListener('mousedown', dismiss);
    window.addEventListener('resize', dismiss);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', dismiss);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('keydown', onKey);
    };
  }, [position, onClose]);

  if (!position || items.length === 0) return null;

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      // Hidden until measured, so it never paints in the wrong place.
      style={
        placed
          ? { left: placed.x, top: placed.y }
          : { left: position.x, top: position.y, visibility: 'hidden' }
      }
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, index) => (
        <button
          key={`${item.label}-${index}`}
          role="menuitem"
          className={item.separator ? 'separated' : undefined}
          disabled={item.disabled}
          onClick={() => {
            onClose();
            item.onSelect?.();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** Tracks where a menu should open, and for which row. */
export function useContextMenu<T>() {
  const [state, setState] = useState<{ position: MenuPosition; target: T } | null>(
    null,
  );

  const open = (event: React.MouseEvent, target: T) => {
    event.preventDefault();
    event.stopPropagation();
    setState({ position: { x: event.clientX, y: event.clientY }, target });
  };

  return {
    position: state?.position ?? null,
    target: state?.target ?? null,
    open,
    close: () => setState(null),
  };
}

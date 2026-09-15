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
  /** Opens a nested menu instead of running an action. */
  items?: MenuItem[];
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
        <MenuRow
          key={`${item.label}-${index}`}
          item={item}
          onClose={onClose}
        />
      ))}
    </div>
  );
}

/** One row, which may open a nested menu.
 *
 * Submenus keep the top level short enough to read: the copy-as formats
 * would otherwise double the length of every menu they appear in.
 */
function MenuRow({ item, onClose }: { item: MenuItem; onClose: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const [flip, setFlip] = useState(false);

  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const box = ref.current.getBoundingClientRect();
    // Opens to the left when there is no room on the right, so a menu
    // near the window edge stays readable.
    setFlip(box.right > window.innerWidth);
  }, [open]);

  if (!item.items) {
    return (
      <button
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
    );
  }

  return (
    <div
      className="context-submenu"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        className={item.separator ? 'separated' : undefined}
        disabled={item.disabled}
        onClick={() => setOpen((value) => !value)}
      >
        {item.label}
        <span aria-hidden="true" className="submenu-arrow">
          ›
        </span>
      </button>
      {open && item.items.length > 0 && (
        <div
          ref={ref}
          role="menu"
          className={flip ? 'context-menu nested flip' : 'context-menu nested'}
        >
          {item.items.map((child, index) => (
            <MenuRow
              key={`${child.label}-${index}`}
              item={child}
              onClose={onClose}
            />
          ))}
        </div>
      )}
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

import { useEffect } from 'react';

import { getShortcut, matchesShortcut, SHORTCUTS } from './shortcuts';

const activeHandlers = new Map<string, () => void>();

function onKeyDown(event: KeyboardEvent): void {
  if (event.repeat || document.querySelector('dialog[open], [data-shortcut-recording="true"]')) {
    return;
  }

  // View actions take priority if an older saved binding happens to collide
  // with a newly introduced navigation default.
  let matched: (() => void) | null = null;
  for (const definition of SHORTCUTS) {
    const handler = activeHandlers.get(definition.id);
    if (!handler || !matchesShortcut(event, getShortcut(definition.id))) continue;
    matched = handler;
    if (definition.category !== 'navigation') break;
  }
  if (!matched) return;

  event.preventDefault();
  event.stopImmediatePropagation();
  matched();
}

/** Registers actions while the owning view is mounted. */
export function useShortcuts(
  handlers: Record<string, () => void>,
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled) return;
    for (const [id, handler] of Object.entries(handlers)) {
      activeHandlers.set(id, handler);
    }
    if (activeHandlers.size > 0) window.addEventListener('keydown', onKeyDown, true);

    return () => {
      for (const [id, handler] of Object.entries(handlers)) {
        if (activeHandlers.get(id) === handler) activeHandlers.delete(id);
      }
      if (activeHandlers.size === 0) window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [handlers, enabled]);
}

export function useShortcut(id: string, handler: () => void, enabled = true): void {
  useShortcuts({ [id]: handler }, enabled);
}

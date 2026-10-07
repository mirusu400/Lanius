import { useEffect } from 'react';

import { getShortcut, matchesShortcut, SHORTCUTS } from './shortcuts';

interface ShortcutHandler {
  run: () => void;
  priority: number;
}

const activeHandlers = new Map<string, Set<ShortcutHandler>>();

function onKeyDown(event: KeyboardEvent): void {
  if (event.repeat || document.querySelector('dialog[open], [data-shortcut-recording="true"]')) {
    return;
  }

  // View actions take priority if an older saved binding happens to collide
  // with a newly introduced navigation default.
  let matched: (() => void) | null = null;
  for (const definition of SHORTCUTS) {
    const handlers = activeHandlers.get(definition.id);
    if (!handlers?.size || !matchesShortcut(event, getShortcut(definition.id))) continue;
    let selected: ShortcutHandler | null = null;
    for (const handler of handlers) {
      if (!selected || handler.priority >= selected.priority) selected = handler;
    }
    matched = selected!.run;
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
  priority = 0,
): void {
  useEffect(() => {
    if (!enabled) return;
    const registrations = Object.entries(handlers).map(([id, run]) => {
      const registration = { run, priority };
      const current = activeHandlers.get(id) ?? new Set<ShortcutHandler>();
      current.add(registration);
      activeHandlers.set(id, current);
      return { id, registration };
    });
    if (activeHandlers.size > 0) window.addEventListener('keydown', onKeyDown, true);

    return () => {
      for (const { id, registration } of registrations) {
        const current = activeHandlers.get(id);
        current?.delete(registration);
        if (current?.size === 0) activeHandlers.delete(id);
      }
      if (activeHandlers.size === 0) window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [handlers, enabled, priority]);
}

export function useShortcut(id: string, handler: () => void, enabled = true): void {
  useShortcuts({ [id]: handler }, enabled);
}

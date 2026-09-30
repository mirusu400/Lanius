import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_TAB_ORDER,
  loadTabOrder,
  moveTab,
  saveTabOrder,
  TAB_ORDER_STORAGE_KEY,
} from './tabOrder';

beforeEach(() => window.localStorage.clear());

describe('tab order', () => {
  it('puts Issues between Dashboard and Proxy by default', () => {
    expect(loadTabOrder().slice(0, 3)).toEqual(['Dashboard', 'Issues', 'Proxy']);
  });

  it('restores a saved order and appends tabs introduced by a newer build', () => {
    window.localStorage.setItem(
      TAB_ORDER_STORAGE_KEY,
      JSON.stringify(['Proxy', 'Dashboard', 'unknown', 'Proxy']),
    );

    const restored = loadTabOrder();
    expect(restored.slice(0, 2)).toEqual(['Proxy', 'Dashboard']);
    expect(restored).not.toContain('unknown');
    expect(new Set(restored)).toEqual(new Set(DEFAULT_TAB_ORDER));
  });

  it('moves a tab before or after the drop target', () => {
    expect(moveTab(DEFAULT_TAB_ORDER, 'Docs', 'Dashboard', 'before')[0]).toBe('Docs');
    expect(moveTab(DEFAULT_TAB_ORDER, 'Dashboard', 'Docs', 'after').at(-1)).toBe('Dashboard');
  });

  it('persists a reordered layout', () => {
    const reordered = moveTab(DEFAULT_TAB_ORDER, 'Proxy', 'Dashboard', 'before');
    saveTabOrder(reordered);
    expect(loadTabOrder()).toEqual(reordered);
  });
});

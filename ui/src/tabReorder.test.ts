import { describe, expect, it } from 'vitest';

import { reorderTabs } from './tabReorder';

const tabs = [
  { id: 'one' },
  { id: 'two' },
  { id: 'three' },
];

describe('reorderTabs', () => {
  it('moves a tab before or after the drop target', () => {
    expect(reorderTabs(tabs, 'three', 'one', 'before').map((tab) => tab.id))
      .toEqual(['three', 'one', 'two']);
    expect(reorderTabs(tabs, 'one', 'three', 'after').map((tab) => tab.id))
      .toEqual(['two', 'three', 'one']);
  });

  it('returns the existing array when the move cannot change its order', () => {
    expect(reorderTabs(tabs, 'one', 'one', 'before')).toBe(tabs);
    expect(reorderTabs(tabs, 'missing', 'two', 'after')).toBe(tabs);
    expect(reorderTabs(tabs, 'one', 'two', 'before')).toBe(tabs);
  });
});

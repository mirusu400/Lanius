import { describe, expect, it } from 'vitest';

import { EMPTY_SELECTION, selectAll, selectFlow, selectModeOf, selectedIds } from './flowSelection';

const ORDER = ['a', 'b', 'c', 'd', 'e'];

describe('history multi-selection', () => {
  it('maps modifier keys the way list views do', () => {
    const keys = { shiftKey: false, ctrlKey: false, metaKey: false };
    expect(selectModeOf(keys)).toBe('replace');
    expect(selectModeOf({ ...keys, ctrlKey: true })).toBe('toggle');
    expect(selectModeOf({ ...keys, metaKey: true })).toBe('toggle');
    expect(selectModeOf({ ...keys, shiftKey: true })).toBe('range');
    expect(selectModeOf({ ...keys, shiftKey: true, metaKey: true })).toBe('addRange');
  });

  it('toggles rows and moves the primary row to the last one added', () => {
    let step = selectFlow(EMPTY_SELECTION, 'b', ORDER, 'd', 'toggle');
    expect(selectedIds(step.selection, step.primary, ORDER)).toEqual(['b', 'd']);
    expect(step.primary).toBe('d');

    step = selectFlow(step.selection, step.primary, ORDER, 'd', 'toggle');
    expect(selectedIds(step.selection, step.primary, ORDER)).toEqual(['b']);
    expect(step.primary).toBe('b');

    // The last row cannot be toggled off: the detail pane needs one.
    step = selectFlow(step.selection, step.primary, ORDER, 'b', 'toggle');
    expect(selectedIds(step.selection, step.primary, ORDER)).toEqual(['b']);
  });

  it('extends a range from the anchor in either direction, or adds it', () => {
    let step = selectFlow(EMPTY_SELECTION, null, ORDER, 'b', 'replace');
    step = selectFlow(step.selection, step.primary, ORDER, 'd', 'range');
    expect(selectedIds(step.selection, step.primary, ORDER)).toEqual(['b', 'c', 'd']);
    // The anchor stays put, so a second Shift+click re-ranges from it.
    step = selectFlow(step.selection, step.primary, ORDER, 'a', 'range');
    expect(selectedIds(step.selection, step.primary, ORDER)).toEqual(['a', 'b']);
    expect(step.primary).toBe('a');

    step = selectFlow(step.selection, step.primary, ORDER, 'e', 'toggle');
    step = selectFlow(step.selection, step.primary, ORDER, 'c', 'addRange');
    expect(selectedIds(step.selection, step.primary, ORDER)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('drops a selection the primary row is no longer part of, and rows off the page', () => {
    const selection = { ids: ['a', 'b'], anchor: 'a' };
    expect(selectedIds(selection, 'c', ORDER)).toEqual(['c']);
    expect(selectedIds(selection, 'b', ['b', 'c'])).toEqual(['b']);
    expect(selectedIds(selection, null, ORDER)).toEqual([]);
  });

  it('selects the whole page, keeping the primary row', () => {
    const step = selectAll(ORDER, 'c');
    expect(selectedIds(step.selection, step.primary, ORDER)).toEqual(ORDER);
    expect(step.primary).toBe('c');
  });
});

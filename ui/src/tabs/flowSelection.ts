/** Several rows selected in the history table.
 *
 * The primary row (the one in the detail pane) stays in selectionStore.
 * This adds the rows selected alongside it, and the anchor that a
 * Shift+click extends from, the way list views work elsewhere.
 */

export interface FlowSelection {
  ids: string[];
  anchor: string | null;
}

/** replace: a plain click. toggle: Ctrl/⌘+click. range: Shift+click.
 * addRange: Ctrl/⌘+Shift+click, as in the Target tab. */
export type SelectMode = 'replace' | 'toggle' | 'range' | 'addRange';

export function selectModeOf(event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): SelectMode {
  const additive = event.ctrlKey || event.metaKey;
  if (event.shiftKey) return additive ? 'addRange' : 'range';
  return additive ? 'toggle' : 'replace';
}

export const EMPTY_SELECTION: FlowSelection = { ids: [], anchor: null };

/** The selected ids in table order, always including the primary row. */
export function selectedIds(
  selection: FlowSelection,
  primary: string | null,
  order: string[],
): string[] {
  // The primary row can be set from elsewhere (a search, another tab).
  // A selection it is not part of is stale, and just the primary remains.
  if (!primary) return [];
  if (!selection.ids.includes(primary)) return order.includes(primary) ? [primary] : [];
  const chosen = new Set(selection.ids);
  return order.filter((id) => chosen.has(id));
}

/** The selection after clicking `id`, and which row becomes primary. */
export function selectFlow(
  selection: FlowSelection,
  primary: string | null,
  order: string[],
  id: string,
  mode: SelectMode,
): { selection: FlowSelection; primary: string } {
  const current = selectedIds(selection, primary, order);
  if (mode === 'toggle') {
    if (!current.includes(id)) {
      return { selection: { ids: [...current, id], anchor: id }, primary: id };
    }
    const rest = current.filter((item) => item !== id);
    // Nothing selected would leave the detail pane with nothing to show.
    if (!rest.length) return { selection: { ids: [id], anchor: id }, primary: id };
    const nextPrimary = id === primary ? rest[rest.length - 1] : primary ?? rest[0];
    return { selection: { ids: rest, anchor: id }, primary: nextPrimary };
  }
  if (mode === 'range' || mode === 'addRange') {
    const anchor = selection.anchor && order.includes(selection.anchor)
      ? selection.anchor
      : primary && order.includes(primary) ? primary : id;
    const from = order.indexOf(anchor);
    const to = order.indexOf(id);
    if (from < 0 || to < 0) return { selection: { ids: [id], anchor: id }, primary: id };
    const [start, end] = from <= to ? [from, to] : [to, from];
    const range = order.slice(start, end + 1);
    const ids = mode === 'addRange' ? [...new Set([...current, ...range])] : range;
    return { selection: { ids, anchor }, primary: id };
  }
  return { selection: { ids: [id], anchor: id }, primary: id };
}

export function selectAll(order: string[], primary: string | null): { selection: FlowSelection; primary: string | null } {
  if (!order.length) return { selection: EMPTY_SELECTION, primary };
  const keep = primary && order.includes(primary) ? primary : order[0];
  return { selection: { ids: [...order], anchor: keep }, primary: keep };
}

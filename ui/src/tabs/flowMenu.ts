/** Menu contents for a captured flow.
 *
 * Kept out of the components so the actions a user gets on right-click
 * can be tested without rendering a table.
 */

import type { MenuItem } from '../components/ContextMenu';
import type { FlowSummary, HistoryColor } from '../api/types';
import type { Translator } from '../i18n';

export interface FlowMenuActions {
  sendToReplay: (flow: FlowSummary) => void;
  sendToFuzzer: (flow: FlowSummary) => void;
  addToScope: (flow: FlowSummary) => void;
  copy: (text: string) => void;
  /** Optional so a menu without deletion still renders. */
  deleteFlow?: (flow: FlowSummary) => void;
  toggleBookmark?: (flow: FlowSummary) => void;
  setColor?: (flow: FlowSummary, color: HistoryColor | null) => void;
}

/** The full URL as it was requested. */
export function flowUrl(flow: FlowSummary): string {
  const scheme = flow.scheme || 'http';
  const port = flow.port;
  // Leave the default port off, the way a browser would show it.
  const omitPort =
    port == null ||
    (scheme === 'https' && port === 443) ||
    (scheme === 'http' && port === 80);
  const host = omitPort ? flow.host : `${flow.host}:${port}`;
  const query = flow.query ? `?${flow.query}` : '';
  return `${scheme}://${host}${flow.path ?? ''}${query}`;
}

export function flowMenuItems(
  flow: FlowSummary,
  t: Translator,
  actions: FlowMenuActions,
  /** The copy-as submenu, built from the formats the engine offers.
   * Optional so the menu still renders where codegen is unavailable. */
  copyAs?: MenuItem,
  pluginActions?: MenuItem,
): MenuItem[] {
  return [
    ...(actions.toggleBookmark ? [{
      label: t(flow.bookmarked ? 'history.removeBookmark' : 'history.addBookmark'),
      onSelect: () => actions.toggleBookmark?.(flow),
    }] : []),
    ...(actions.setColor ? [{
      label: t('history.highlight'),
      items: ([
        { label: t('history.noColor'), onSelect: () => actions.setColor?.(flow, null) },
        ...(['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as HistoryColor[]).map((color) => ({
          label: `${flow.annotation_color === color ? '✓ ' : ''}${t(`history.color.${color}`)}`,
          onSelect: () => actions.setColor?.(flow, color),
        })),
      ]),
    }] : []),
    {
      label: t('menu.sendToReplay'),
      separator: Boolean(actions.toggleBookmark || actions.setColor),
      onSelect: () => actions.sendToReplay(flow),
    },
    {
      label: t('menu.sendToFuzzer'),
      onSelect: () => actions.sendToFuzzer(flow),
    },
    {
      label: t('menu.addToScope'),
      separator: true,
      onSelect: () => actions.addToScope(flow),
    },
    {
      label: t('menu.copyUrl'),
      separator: true,
      onSelect: () => actions.copy(flowUrl(flow)),
    },
    ...(copyAs ? [copyAs] : []),
    ...(pluginActions ? [pluginActions] : []),
    // Last, separated and marked: a capture is mostly noise and removing
    // it is what keeps the database from growing without bound, but it
    // is also the one item here that cannot be undone.
    ...(actions.deleteFlow
      ? [
          {
            label: t('menu.deleteFlow'),
            separator: true,
            danger: true,
            onSelect: () => actions.deleteFlow?.(flow),
          },
        ]
      : []),
  ];
}

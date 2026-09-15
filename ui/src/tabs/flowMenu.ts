/** Menu contents for a captured flow.
 *
 * Kept out of the components so the actions a user gets on right-click
 * can be tested without rendering a table.
 */

import type { MenuItem } from '../components/ContextMenu';
import type { FlowSummary } from '../api/types';
import type { Translator } from '../i18n';

export interface FlowMenuActions {
  sendToRepeater: (flow: FlowSummary) => void;
  sendToIntruder: (flow: FlowSummary) => void;
  addToScope: (flow: FlowSummary) => void;
  copy: (text: string) => void;
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
): MenuItem[] {
  return [
    {
      label: t('menu.sendToRepeater'),
      onSelect: () => actions.sendToRepeater(flow),
    },
    {
      label: t('menu.sendToIntruder'),
      onSelect: () => actions.sendToIntruder(flow),
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
  ];
}

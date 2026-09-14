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

/** A curl command that repeats this request. */
export function flowAsCurl(flow: FlowSummary): string {
  const parts = ['curl'];
  if (flow.method && flow.method !== 'GET') parts.push('-X', flow.method);
  // Quote it: a URL with a query string would otherwise be split by the
  // shell on & and ?.
  parts.push(`'${flowUrl(flow).replace(/'/g, "'\\''")}'`);
  return parts.join(' ');
}

export function flowMenuItems(
  flow: FlowSummary,
  t: Translator,
  actions: FlowMenuActions,
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
    {
      label: t('menu.copyAsCurl'),
      onSelect: () => actions.copy(flowAsCurl(flow)),
    },
  ];
}

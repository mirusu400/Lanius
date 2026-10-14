/** Request actions shared by captured flows and editable requests.
 *
 * Each screen supplies callbacks for its own request source. The menu owns
 * the common ordering, labels, separators and URL copy behavior.
 */
import type { Translator } from '../i18n';
import type { MenuItem } from './ContextMenu';
import type { ScopeKind, ScopeTarget } from './requestScope';

export interface RequestMenuOptions {
  url: string | null;
  sendToReplay?: () => void;
  sendToFuzzer?: () => void;
  addScopeRule?: (kind: ScopeKind, target: ScopeTarget) => void;
  copyUrl?: (url: string) => void;
  /** Use when only a flow ID is available and the URL must be loaded first. */
  copyUrlAction?: () => void;
  copyAs?: MenuItem;
  pluginActions?: MenuItem;
  before?: MenuItem[];
  after?: MenuItem[];
}

export function requestMenuItems(t: Translator, options: RequestMenuOptions): MenuItem[] {
  const {
    url, sendToReplay, sendToFuzzer, addScopeRule, copyUrl, copyUrlAction,
    copyAs, pluginActions, before = [], after = [],
  } = options;
  return [
    ...before,
    ...(sendToReplay ? [{
      label: t('menu.sendToReplay'),
      shortcutId: 'request.sendToReplay',
      separator: before.length > 0,
      onSelect: sendToReplay,
    }] : []),
    ...(sendToFuzzer ? [{
      label: t('menu.sendToFuzzer'),
      shortcutId: 'request.sendToFuzzer',
      onSelect: sendToFuzzer,
    }] : []),
    ...(addScopeRule ? requestScopeMenuItems(t, addScopeRule) : []),
    {
      label: t('menu.copyUrl'),
      separator: Boolean(before.length || sendToReplay || sendToFuzzer || addScopeRule),
      disabled: !url && !copyUrlAction,
      onSelect: () => {
        if (copyUrlAction) { copyUrlAction(); return; }
        if (url) {
          if (copyUrl) copyUrl(url);
          else void navigator.clipboard?.writeText(url);
        }
      },
    },
    ...(copyAs ? [copyAs] : []),
    ...(pluginActions ? [pluginActions] : []),
    ...after,
  ];
}

export function requestScopeMenuItems(
  t: Translator,
  onAdd: (kind: ScopeKind, target: ScopeTarget) => void,
  separated = true,
): MenuItem[] {
  return (['include', 'exclude'] as const).map((kind, index) => ({
    label: t(kind === 'include' ? 'menu.scopeIncludeRule' : 'menu.scopeExcludeRule'),
    separator: separated && index === 0,
    items: ([
      { label: t('menu.scopeHostname'), onSelect: () => onAdd(kind, 'hostname') },
      { label: t('menu.scopePath'), onSelect: () => onAdd(kind, 'path') },
    ]),
  }));
}

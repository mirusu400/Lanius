/** Which plugin message views exist, and how their tabs are keyed. */

import { useCallback, useEffect, useState } from 'react';

import { listPluginContributions } from '../api/client';
import type { PluginMessageSide, PluginMessageViewContribution } from '../api/types';

const PREFIX = 'plugin:';

export type PluginViewKey = `plugin:${string}`;

export function pluginViewKey(view: PluginMessageViewContribution): PluginViewKey {
  return `${PREFIX}${view.id}`;
}

export function isPluginViewKey(value: string): value is PluginViewKey {
  return value.startsWith(PREFIX);
}

export function findPluginView(
  views: PluginMessageViewContribution[],
  key: string,
): PluginMessageViewContribution | undefined {
  return isPluginViewKey(key)
    ? views.find((view) => view.id === key.slice(PREFIX.length))
    : undefined;
}

/** Message views registered by loaded plugins, kept current as plugins change. */
export function usePluginMessageViews(enabled = true): PluginMessageViewContribution[] {
  const [views, setViews] = useState<PluginMessageViewContribution[]>([]);

  const refresh = useCallback(async () => {
    try {
      const catalogue = await listPluginContributions();
      setViews(Array.isArray(catalogue.message_views) ? catalogue.message_views : []);
    } catch {
      // An unavailable engine leaves the built-in views; they need no plugin.
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const changed = () => void refresh();
    window.addEventListener('lanius.pluginsChanged', changed);
    return () => window.removeEventListener('lanius.pluginsChanged', changed);
  }, [enabled, refresh]);

  return enabled ? views : [];
}

export function viewsForSide(
  views: PluginMessageViewContribution[],
  side: PluginMessageSide,
): PluginMessageViewContribution[] {
  return views.filter((view) => view.sides.includes(side));
}

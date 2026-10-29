import { useCallback, useEffect, useState } from 'react';

import { invokePluginAction, listPluginContributions } from '../api/client';
import type {
  PluginActionContribution,
  PluginActionLocation,
} from '../api/types';
import { useT } from '../i18n';
import { openPluginActionView } from './pluginViewBridge';
import type { MenuItem } from './ContextMenu';
import { useToast } from './Toast';

/** Makes SDK actions visible at the UI locations declared by their plugin. */
export function usePluginActions(
  onError?: (message: string) => void,
  onInvoked?: (result: unknown) => void,
) {
  const t = useT();
  const { showToast } = useToast();
  const [actions, setActions] = useState<PluginActionContribution[]>([]);

  const refresh = useCallback(async () => {
    try {
      const catalogue = await listPluginContributions();
      setActions(Array.isArray(catalogue.actions) ? catalogue.actions : []);
    } catch {
      // A temporarily unavailable engine should not hide the rest of a tool.
      // Invocation errors are surfaced because those follow an explicit click.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const changed = () => void refresh();
    window.addEventListener('lanius.pluginsChanged', changed);
    return () => window.removeEventListener('lanius.pluginsChanged', changed);
  }, [refresh]);

  const actionsAt = useCallback(
    (locations: PluginActionLocation[]) => actions.filter((action) =>
      action.locations.some((location) => locations.includes(location))),
    [actions],
  );

  const invoke = useCallback(
    async (action: PluginActionContribution, context: Record<string, unknown>) => {
      try {
        const response = await invokePluginAction(action.id, context);
        onInvoked?.(response.result);
        openPluginActionView(action.plugin, response.result);
        const result = response.result;
        if (result && typeof result === 'object' &&
          'check_ids' in result && Array.isArray(result.check_ids) &&
          'id' in result && typeof result.id === 'string') {
          showToast({ message: t('issues.scanStarted'), tone: 'success', category: 'scanner' });
        }
      } catch (error) {
        const message = (error as Error).message;
        showToast({
          message: t('plugins.actionFailed', { name: action.title, message }),
          tone: 'error',
          category: 'plugins',
        });
        onError?.(message);
      }
    },
    [onError, onInvoked, showToast, t],
  );

  const buildMenu = useCallback(
    (
      locations: PluginActionLocation[],
      context: Record<string, unknown>,
      separator = true,
    ): MenuItem | undefined => {
      const available = actionsAt(locations);
      if (available.length === 0) return undefined;
      return {
        label: t('plugins.actions'),
        separator,
        items: available.map((action) => ({
          label: `${action.title} · ${action.plugin}`,
          onSelect: () => void invoke(action, {
            ...context,
            location: action.locations.find((location) => locations.includes(location)),
          }),
        })),
      };
    },
    [actionsAt, invoke, t],
  );

  return { actionsAt, buildMenu, invoke, refresh };
}

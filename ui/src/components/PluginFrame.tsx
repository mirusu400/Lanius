import { useEffect, useRef } from 'react';

import {
  getPluginSettings,
  invokePluginAction,
  listPluginContributions,
  patchPluginSettings,
  pluginUiUrl,
} from '../api/client';
import type { PluginInfo, PluginUiView } from '../api/types';
import { useT } from '../i18n';

interface RpcRequest {
  type: 'lanius.request';
  plugin: string;
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

function isRequest(value: unknown): value is RpcRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<RpcRequest>;
  return request.type === 'lanius.request'
    && typeof request.plugin === 'string'
    && typeof request.id === 'string'
    && typeof request.method === 'string';
}

/** An opaque-origin frame with a small, permission-checked message bridge. */
export function PluginFrame({
  plugin,
  view,
  onClose,
}: {
  plugin: PluginInfo;
  view: PluginUiView;
  onClose: () => void;
}) {
  const t = useT();
  const frame = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    const permissions = new Set(plugin.package?.permissions ?? []);
    const receive = async (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || !isRequest(event.data)) return;
      const request = event.data;
      if (request.plugin !== plugin.name) return;
      const params = request.params ?? {};
      try {
        let result: unknown;
        if (request.method === 'contributions.list') {
          const catalogue = await listPluginContributions();
          result = Object.fromEntries(
            Object.entries(catalogue).map(([kind, items]) => [
              kind,
              (items as Array<{ plugin: string }>).filter(
                (item) => item.plugin === plugin.name,
              ),
            ]),
          );
        } else if (request.method === 'actions.invoke') {
          if (!permissions.has('actions.invoke')) throw new Error('permission denied: actions.invoke');
          const action = String(params.action ?? '');
          if (!action.startsWith(`${plugin.name}.`)) throw new Error('a plugin can only invoke its own actions');
          result = (await invokePluginAction(action, (params.context as Record<string, unknown>) ?? {})).result;
        } else if (request.method === 'settings.get') {
          if (!permissions.has('settings.read')) throw new Error('permission denied: settings.read');
          result = await getPluginSettings(plugin.name);
        } else if (request.method === 'settings.patch') {
          if (!permissions.has('settings.write')) throw new Error('permission denied: settings.write');
          result = await patchPluginSettings(
            plugin.name,
            (params.values as Record<string, unknown>) ?? {},
          );
        } else {
          throw new Error(`unsupported method: ${request.method}`);
        }
        frame.current?.contentWindow?.postMessage(
          { type: 'lanius.response', id: request.id, result },
          '*',
        );
      } catch (error) {
        frame.current?.contentWindow?.postMessage(
          { type: 'lanius.response', id: request.id, error: (error as Error).message },
          '*',
        );
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [plugin, view]);

  return (
    <section className="plugin-frame-shell">
      <header>
        <strong>{plugin.package?.name ?? plugin.name} · {view.title}</strong>
        <span className="spacer" />
        <button aria-label={t('common.close')} onClick={onClose}>×</button>
      </header>
      <iframe
        ref={frame}
        title={`${plugin.name}: ${view.title}`}
        src={pluginUiUrl(plugin.name, view.entrypoint)}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
      />
    </section>
  );
}

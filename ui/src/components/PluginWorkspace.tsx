import { Activity, useCallback, useEffect, useEffectEvent, useMemo, useRef, useState, type ReactNode } from 'react';
import { listPlugins } from '../api/client';
import { connectStream } from '../api/stream';
import type { PluginInfo } from '../api/types';
import { PluginFrame } from './PluginFrame';
import { PluginWorkspaceContext, type View, type Request } from './pluginViewBridge';

export function PluginWorkspaceProvider({ children }: { children: ReactNode }) {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [visited, setVisited] = useState<Set<string>>(() => new Set());
  const select = useCallback((key: string | null) => {
    setActive(key);
    if (key) setVisited((current) => current.has(key) ? current : new Set([...current, key]));
  }, []);
  const [request, setRequest] = useState<Request | null>(null);
  useEffect(() => {
    let live = true;
    let revision = 0;
    const update = (items: PluginInfo[]) => {
      if (!live) return;
      const available = items.filter((item) => item.loaded);
      setPlugins(available);
      setRequest((current) => current && available.some((item) => item.name === current.plugin) ? current : null);
      setActive((current) => current && available.some((item) => item.ui?.views.some((view) =>
        view.placement === 'tab' && `${item.name}/${view.id}` === current)) ? current : null);
    };
    const refresh = () => {
      const generation = ++revision;
      void listPlugins().then((data) => {
        if (generation === revision) update(data.suspended ? [] : data.items);
      }).catch(() => undefined);
    };
    refresh();
    const stop = connectStream({
      onState: (state) => { if (state === 'open') refresh(); },
      onEvent: (event) => {
        if (event.type === 'plugins.changed') {
          revision++;
          update(event.data);
          window.dispatchEvent(new Event('lanius.pluginsChanged'));
        }
      },
    });
    return () => { live = false; stop(); };
  }, []);
  const views = useMemo(() => plugins.flatMap((plugin) => (plugin.ui?.views ?? []).map((view) => ({
    key: `${plugin.name}/${view.id}`, plugin, view,
  }))), [plugins]);
  const tabs = useMemo(() => views.filter(({ view }) => view.placement === 'tab'), [views]);
  const openPluginView = useEffectEvent((event: Event) => {
    const next = (event as CustomEvent<Request>).detail;
    const found = views.find(({ plugin, view }) => plugin.name === next.plugin && view.id === next.view);
    if (!found || (next.mode === 'tab' && found.view.placement !== 'tab')) return;
    setRequest(next);
    if (next.mode === 'tab') select(found.key);
  });
  useEffect(() => {
    // Keep one listener for the provider's lifetime. Replacing it every time
    // the plugin list renders leaves a gap where a just-rendered action can
    // dispatch its view request before the new listener has been installed.
    const open = (event: Event) => openPluginView(event);
    window.addEventListener('lanius.openPluginView', open);
    return () => window.removeEventListener('lanius.openPluginView', open);
  }, []);
  const selected = tabs.find(({ key }) => key === active);
  const dialog = request?.mode === 'dialog'
    ? views.find(({ plugin, view }) => plugin.name === request.plugin && view.id === request.view)
    : undefined;
  const close = useCallback(() => setRequest(null), []);
  const content = <>
    {tabs.filter(({ key }) => visited.has(key)).map((item) => <Activity key={item.key} mode={active === item.key ? 'visible' : 'hidden'}>
      <PluginFrame plugin={item.plugin} view={item.view} embedded
        context={request?.mode === 'tab' && request.plugin === item.plugin.name ? request.context : undefined} />
    </Activity>)}
    {dialog && <PluginDialog item={dialog} context={request?.context} onClose={close} />}
  </>;
  return <PluginWorkspaceContext.Provider value={{ tabs, active: selected ? active : null, select, content }}>{children}</PluginWorkspaceContext.Provider>;
}

function PluginDialog({ item, context, onClose }: {
  item: View; context?: Record<string, unknown>; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="plugin-dialog-backdrop" aria-label={item.view.title}
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <PluginFrame plugin={item.plugin} view={item.view} context={context} onClose={onClose} />
  </dialog>;
}


import { useCallback, useEffect, useState } from 'react';

import { listPlugins, reloadPlugin, setPluginAutoReload, setPluginEnabled, setPluginOrder } from '../api/client';
import type { PluginInfo } from '../api/types';
import { msg, rawMsg, renderMessage, useT, type Message } from '../i18n';
import { useReportBusy } from '../components/busy';
import { ResizableFillCell, ResizableFillHeader, ResizableHeader, ResizableTable, useResizableColumns } from '../components/ResizableColumns';

export function PluginsTab() {
  const t = useT();
  const columns = useResizableColumns('lanius.columns.plugins', [80, 100, 100, 180, 360, 180, 100, 100]);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [directory, setDirectory] = useState('');
  const [safeMode, setSafeMode] = useState(false);
  const [error, setError] = useState<Message | null>(null);

  // `refresh` must not clear `error`: it runs right after a failed
  // enable/reload, and wiping the banner would hide why it failed.
  // First load only: a refresh after toggling a plugin should not throw
  // a spinner over the list you just clicked in.
  const [loading, setLoading] = useState(true);
  useReportBusy('plugins', loading);

  const refresh = useCallback(async () => {
    try {
      const data = await listPlugins();
      setPlugins(data.items);
      setDirectory(data.directory);
      setSafeMode(data.safe_mode);
    } catch (err) {
      setError(msg('plugins.listFailed', { message: (err as Error).message }));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = async (plugin: PluginInfo) => {
    try {
      await setPluginEnabled(plugin.name, !plugin.enabled);
      setError(null);
    } catch (err) {
      setError(rawMsg(`${plugin.name}: ${(err as Error).message}`));
    }
    await refresh();
  };

  const reload = async (plugin: PluginInfo) => {
    try {
      await reloadPlugin(plugin.name);
      setError(null);
    } catch (err) {
      setError(rawMsg(`${plugin.name}: ${(err as Error).message}`));
    }
    await refresh();
  };

  const move = async (plugin: PluginInfo, offset: number) => {
    const names = plugins.map((item) => item.name);
    const index = names.indexOf(plugin.name);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= names.length) return;
    [names[index], names[target]] = [names[target], names[index]];
    try {
      await setPluginOrder(names);
      setError(null);
    } catch (err) {
      setError(rawMsg(`${plugin.name}: ${(err as Error).message}`));
    }
    await refresh();
  };

  const toggleAutoReload = async (plugin: PluginInfo) => {
    try {
      await setPluginAutoReload(plugin.name, !plugin.auto_reload);
      setError(null);
    } catch (err) {
      setError(rawMsg(`${plugin.name}: ${(err as Error).message}`));
    }
    await refresh();
  };

  return (
    <div className="plugins-tab">
      <div className="plugins-header">
        <span className="muted mono">{directory}</span>
        <span className="spacer" />
        <button onClick={() => void refresh()}>{t('plugins.rescan')}</button>
      </div>
      {safeMode && <div className="banner warning">{t('plugins.safeMode')}</div>}
      {error && <div className="banner error">{renderMessage(error, t)}</div>}

      {plugins.length === 0 ? (
        <p className="muted pad">
          {t('plugins.none')}
        </p>
      ) : (
        <ResizableTable columns={columns} className="flow-table plugins-table">
          <thead>
            <tr>
              {[t('plugins.use'), t('plugins.order'), t('plugins.autoReload'), t('common.name'), t('common.description'), t('plugins.hooks'), t('common.status'), t('plugins.reload')].map((label, index) => (
                <ResizableHeader key={index} label={label} index={index} columns={columns} resizeLabel={t('table.resizeColumn', { column: label })} />
              ))}
              <ResizableFillHeader />
            </tr>
          </thead>
          <tbody>
            {plugins.map((plugin) => (
              <tr key={plugin.name} className={plugin.error ? 'plugin-error' : undefined}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={t('plugins.toggleLabel', { name: plugin.name })}
                    checked={plugin.enabled}
                    onChange={() => void toggle(plugin)}
                  />
                </td>
                <td>
                  <button
                    aria-label={t('plugins.moveUpLabel', { name: plugin.name })}
                    disabled={plugin.order === 0}
                    onClick={() => void move(plugin, -1)}
                  >
                    ↑
                  </button>
                  <button
                    aria-label={t('plugins.moveDownLabel', { name: plugin.name })}
                    disabled={plugin.order === plugins.length - 1}
                    onClick={() => void move(plugin, 1)}
                  >
                    ↓
                  </button>
                </td>
                <td>
                  <input
                    type="checkbox"
                    aria-label={t('plugins.autoReloadLabel', { name: plugin.name })}
                    checked={plugin.auto_reload}
                    onChange={() => void toggleAutoReload(plugin)}
                  />
                </td>
                <td className="mono">
                  {plugin.name}
                  {plugin.version && (
                    <span className="muted"> v{plugin.version}</span>
                  )}
                </td>
                <td>
                  {plugin.description ?? <span className="muted">{t('common.none')}</span>}
                  {plugin.error && (
                    <div className="plugin-error-text mono">{plugin.error}</div>
                  )}
                </td>
                <td className="mono">
                  {plugin.hooks.map((hook) => (
                    <span key={hook} className="param">
                      {hook}
                    </span>
                  ))}
                </td>
                <td className="mono">
                  {plugin.loaded ? (
                    <span className="status-2xx">{t('plugins.loaded')}</span>
                  ) : plugin.error ? (
                    <span className="status-5xx">{t('common.error')}</span>
                  ) : (
                    <span className="muted">{t('plugins.idle')}</span>
                  )}
                </td>
                <td>
                  <button
                    aria-label={t('plugins.reloadLabel', { name: plugin.name })}
                    onClick={() => void reload(plugin)}
                  >
                    {t('plugins.reload')}
                  </button>
                </td>
                <ResizableFillCell />
              </tr>
            ))}
          </tbody>
        </ResizableTable>
      )}
    </div>
  );
}

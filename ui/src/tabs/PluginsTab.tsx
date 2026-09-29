import { useCallback, useEffect, useState } from 'react';

import { listPlugins, reloadPlugin, setPluginEnabled } from '../api/client';
import type { PluginInfo } from '../api/types';
import { msg, rawMsg, renderMessage, useT, type Message } from '../i18n';
import { useReportBusy } from '../components/busy';
import { ResizableFillCell, ResizableFillHeader, ResizableHeader, ResizableTable, useResizableColumns } from '../components/ResizableColumns';

export function PluginsTab() {
  const t = useT();
  const columns = useResizableColumns('lanius.columns.plugins', [80, 180, 360, 180, 100, 100]);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [directory, setDirectory] = useState('');
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

  return (
    <div className="plugins-tab">
      <div className="plugins-header">
        <span className="muted mono">{directory}</span>
        <span className="spacer" />
        <button onClick={() => void refresh()}>{t('plugins.rescan')}</button>
      </div>
      {error && <div className="banner error">{renderMessage(error, t)}</div>}

      {plugins.length === 0 ? (
        <p className="muted pad">
          {t('plugins.none')}
        </p>
      ) : (
        <ResizableTable columns={columns} className="flow-table plugins-table">
          <thead>
            <tr>
              {[t('plugins.use'), t('common.name'), t('common.description'), t('plugins.hooks'), t('common.status'), t('plugins.reload')].map((label, index) => (
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

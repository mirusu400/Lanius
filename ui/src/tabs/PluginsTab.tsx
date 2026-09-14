import { useCallback, useEffect, useState } from 'react';

import { listPlugins, reloadPlugin, setPluginEnabled } from '../api/client';
import type { PluginInfo } from '../api/types';
import { useT } from '../i18n';

export function PluginsTab() {
  const t = useT();
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [directory, setDirectory] = useState('');
  const [error, setError] = useState<string | null>(null);

  // `refresh` must not clear `error`: it runs right after a failed
  // enable/reload, and wiping the banner would hide why it failed.
  const refresh = useCallback(async () => {
    try {
      const data = await listPlugins();
      setPlugins(data.items);
      setDirectory(data.directory);
    } catch (err) {
      setError(t('plugins.listFailed', { message: (err as Error).message }));
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = async (plugin: PluginInfo) => {
    try {
      await setPluginEnabled(plugin.name, !plugin.enabled);
      setError(null);
    } catch (err) {
      setError(`${plugin.name}: ${(err as Error).message}`);
    }
    await refresh();
  };

  const reload = async (plugin: PluginInfo) => {
    try {
      await reloadPlugin(plugin.name);
      setError(null);
    } catch (err) {
      setError(`${plugin.name}: ${(err as Error).message}`);
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
      {error && <div className="banner error">{error}</div>}

      {plugins.length === 0 ? (
        <p className="muted pad">
          {t('plugins.none')}
        </p>
      ) : (
        <table className="flow-table plugins-table">
          <thead>
            <tr>
              <th className="col-size">{t('plugins.use')}</th>
              <th className="col-host">{t('common.name')}</th>
              <th>{t('common.description')}</th>
              <th className="col-host">{t('plugins.hooks')}</th>
              <th className="col-size">{t('common.status')}</th>
              <th className="col-size" />
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
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

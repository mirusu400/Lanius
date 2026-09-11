import { useCallback, useEffect, useState } from 'react';

import { listPlugins, reloadPlugin, setPluginEnabled } from '../api/client';
import type { PluginInfo } from '../api/types';

export function PluginsTab() {
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
      setError(`플러그인 목록을 불러오지 못했습니다: ${(err as Error).message}`);
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
        <button onClick={() => void refresh()}>다시 검색</button>
      </div>
      {error && <div className="banner error">{error}</div>}

      {plugins.length === 0 ? (
        <p className="muted pad">
          플러그인이 없습니다. 위 디렉터리에 <code>*.py</code> 파일을 넣고 다시
          검색하세요.
        </p>
      ) : (
        <table className="flow-table plugins-table">
          <thead>
            <tr>
              <th className="col-size">사용</th>
              <th className="col-host">이름</th>
              <th>설명</th>
              <th className="col-host">훅</th>
              <th className="col-size">상태</th>
              <th className="col-size" />
            </tr>
          </thead>
          <tbody>
            {plugins.map((plugin) => (
              <tr key={plugin.name} className={plugin.error ? 'plugin-error' : undefined}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`toggle ${plugin.name}`}
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
                  {plugin.description ?? <span className="muted">—</span>}
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
                    <span className="status-2xx">loaded</span>
                  ) : plugin.error ? (
                    <span className="status-5xx">error</span>
                  ) : (
                    <span className="muted">idle</span>
                  )}
                </td>
                <td>
                  <button
                    aria-label={`reload ${plugin.name}`}
                    onClick={() => void reload(plugin)}
                  >
                    reload
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

import { useCallback, useEffect, useRef, useState } from 'react';

import { getPluginSettings, installDevelopmentPlugin, installPluginPackage, listPlugins, patchPluginSettings, reloadPlugin, setPluginAutoReload, setPluginEnabled, setPluginOrder, uninstallPluginPackage } from '../api/client';
import type { PluginInfo, PluginSettingField, PluginSettings, PluginUiView } from '../api/types';
import { msg, rawMsg, renderMessage, useT, type Message } from '../i18n';
import { useReportBusy } from '../components/busy';
import { ResizableFillCell, ResizableFillHeader, ResizableHeader, ResizableTable, useResizableColumns } from '../components/ResizableColumns';
import { PluginFrame } from '../components/PluginFrame';

export function PluginsTab() {
  const t = useT();
  const columns = useResizableColumns('lanius.columns.plugins', [80, 100, 100, 180, 320, 180, 180, 100, 160]);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [directory, setDirectory] = useState('');
  const [safeMode, setSafeMode] = useState(false);
  const [developmentMode, setDevelopmentMode] = useState(false);
  const [error, setError] = useState<Message | null>(null);
  const [settings, setSettings] = useState<PluginSettings | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<Record<string, unknown>>({});
  const [savingSettings, setSavingSettings] = useState(false);
  const [developmentPath, setDevelopmentPath] = useState('');
  const [activeView, setActiveView] = useState<{ plugin: PluginInfo; view: PluginUiView } | null>(null);
  const packageInput = useRef<HTMLInputElement | null>(null);

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
      setDevelopmentMode(data.development_mode);
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

  const openSettings = async (plugin: PluginInfo) => {
    try {
      const data = await getPluginSettings(plugin.name);
      setSettings(data);
      setSettingsDraft(data.values);
      setError(null);
    } catch (err) {
      setError(rawMsg(`${plugin.name}: ${(err as Error).message}`));
    }
  };

  const saveSettings = async () => {
    if (!settings) return;
    setSavingSettings(true);
    try {
      const data = await patchPluginSettings(settings.plugin, settingsDraft);
      setSettings(data);
      setSettingsDraft(data.values);
      setError(null);
    } catch (err) {
      setError(rawMsg(`${settings.plugin}: ${(err as Error).message}`));
    } finally {
      setSavingSettings(false);
    }
  };

  const changeSetting = (field: PluginSettingField, value: unknown) => {
    setSettingsDraft((current) => ({ ...current, [field.key]: value }));
  };

  const contributionSummary = (plugin: PluginInfo) => {
    const entries = [
      ['A', plugin.contributions.actions],
      ['C', plugin.contributions.codecs],
      ['G', plugin.contributions.payload_generators],
      ['P', plugin.contributions.payload_processors],
      ['S', plugin.contributions.settings],
      ['PS', plugin.contributions.passive_scanners],
      ['AS', plugin.contributions.active_scanners],
    ].filter((entry) => Number(entry[1]) > 0);
    return entries.map(([kind, count]) => `${kind}:${count}`).join(' · ');
  };

  const installPackage = async (file: File) => {
    try {
      await installPluginPackage(file);
      setError(null);
    } catch (err) {
      setError(rawMsg((err as Error).message));
    }
    if (packageInput.current) packageInput.current.value = '';
    await refresh();
  };

  const installDevelopment = async () => {
    if (!developmentPath.trim()) return;
    try {
      await installDevelopmentPlugin(developmentPath.trim());
      setDevelopmentPath('');
      setError(null);
    } catch (err) {
      setError(rawMsg((err as Error).message));
    }
    await refresh();
  };

  const uninstall = async (plugin: PluginInfo) => {
    try {
      await uninstallPluginPackage(plugin.name);
      if (activeView?.plugin.name === plugin.name) setActiveView(null);
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
        {developmentMode && (
          <>
            <input
              aria-label={t('plugins.developmentPath')}
              placeholder={t('plugins.developmentPath')}
              value={developmentPath}
              onChange={(event) => setDevelopmentPath(event.target.value)}
            />
            <button onClick={() => void installDevelopment()}>{t('plugins.linkDevelopment')}</button>
          </>
        )}
        <input
          ref={packageInput}
          className="visually-hidden"
          type="file"
          accept=".lanius-plugin,application/zip"
          aria-label={t('plugins.packageFile')}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void installPackage(file);
          }}
        />
        <button onClick={() => packageInput.current?.click()}>{t('plugins.install')}</button>
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
              {[t('plugins.use'), t('plugins.order'), t('plugins.autoReload'), t('common.name'), t('common.description'), t('plugins.hooks'), t('plugins.contributions'), t('common.status'), t('plugins.actions')].map((label, index) => (
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
                  {plugin.package && (
                    <span className={`plugin-trust plugin-trust-${plugin.package.trust}`}>
                      {plugin.package.trust}
                    </span>
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
                  {plugin.sdk_api_version && <span className="param">SDK {plugin.sdk_api_version}</span>}
                  {contributionSummary(plugin) || <span className="muted">{t('common.none')}</span>}
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
                  {(plugin.contributions.settings ?? 0) > 0 && (
                    <button
                      aria-label={t('plugins.settingsLabel', { name: plugin.name })}
                      onClick={() => void openSettings(plugin)}
                    >
                      {t('plugins.settings')}
                    </button>
                  )}
                  {plugin.ui?.views.map((view) => (
                    <button
                      key={view.id}
                      disabled={!plugin.loaded}
                      onClick={() => setActiveView({ plugin, view })}
                    >
                      {view.title}
                    </button>
                  ))}
                  <button
                    aria-label={t('plugins.reloadLabel', { name: plugin.name })}
                    onClick={() => void reload(plugin)}
                  >
                    {t('plugins.reload')}
                  </button>
                  {plugin.package && (
                    <button className="danger" onClick={() => void uninstall(plugin)}>
                      {t('plugins.uninstall')}
                    </button>
                  )}
                </td>
                <ResizableFillCell />
              </tr>
            ))}
          </tbody>
        </ResizableTable>
      )}
      {settings && (
        <section className="plugin-settings-panel" aria-label={t('plugins.settingsFor', { name: settings.plugin })}>
          <div className="plugin-settings-heading">
            <strong>{t('plugins.settingsFor', { name: settings.plugin })}</strong>
            <button aria-label={t('common.close')} onClick={() => setSettings(null)}>×</button>
          </div>
          {settings.fields.map((field) => (
            <label key={field.key} className="plugin-setting-field">
              <span>
                {field.title}
                <small>{field.scope === 'user' ? t('plugins.userScope') : t('plugins.projectScope')}</small>
              </span>
              {field.kind === 'boolean' ? (
                <input
                  type="checkbox"
                  checked={Boolean(settingsDraft[field.key])}
                  onChange={(event) => changeSetting(field, event.target.checked)}
                />
              ) : field.kind === 'enum' ? (
                <select
                  value={String(settingsDraft[field.key] ?? '')}
                  onChange={(event) => changeSetting(field, event.target.value)}
                >
                  {field.choices.map((choice) => <option key={choice}>{choice}</option>)}
                </select>
              ) : (
                <input
                  type={field.kind === 'integer' || field.kind === 'number' ? 'number' : 'text'}
                  step={field.kind === 'integer' ? 1 : field.kind === 'number' ? 'any' : undefined}
                  value={String(settingsDraft[field.key] ?? '')}
                  onChange={(event) => changeSetting(
                    field,
                    field.kind === 'integer' || field.kind === 'number'
                      ? Number(event.target.value)
                      : event.target.value,
                  )}
                />
              )}
              {field.description && <small className="muted">{field.description}</small>}
            </label>
          ))}
          <button disabled={savingSettings} onClick={() => void saveSettings()}>
            {savingSettings ? t('plugins.savingSettings') : t('plugins.saveSettings')}
          </button>
        </section>
      )}
      {activeView && (
        <PluginFrame
          plugin={activeView.plugin}
          view={activeView.view}
          onClose={() => setActiveView(null)}
        />
      )}
    </div>
  );
}

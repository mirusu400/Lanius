import { useCallback, useEffect, useRef, useState } from 'react';

import {
  getPluginCatalogue,
  getPluginSettings,
  installCataloguePlugin,
  installDevelopmentPlugin,
  installPluginPackage,
  listPlugins,
  patchPluginSettings,
  reloadPlugin,
  rollbackPlugin,
  savePluginCatalogueSources,
  setPluginAutoReload,
  setPluginEnabled,
  setPluginOrder,
  uninstallPluginPackage,
} from '../api/client';
import type {
  PluginCatalogue,
  PluginCatalogueItem,
  PluginCatalogueSource,
  PluginInfo,
  PluginSettingField,
  PluginSettings,
  PluginUiView,
} from '../api/types';
import { msg, rawMsg, renderMessage, useT, type Message } from '../i18n';
import { useReportBusy } from '../components/busy';
import { ResizableFillCell, ResizableFillHeader, ResizableHeader, ResizableTable, useResizableColumns } from '../components/ResizableColumns';
import { PluginFrame } from '../components/PluginFrame';

const EMPTY_CATALOGUE: PluginCatalogue = {
  sources: [],
  items: [],
  errors: {},
  refreshed: false,
};

const EMPTY_SOURCE: PluginCatalogueSource = {
  id: '',
  title: '',
  url: '',
  public_key: '',
  key_id: null,
  enabled: true,
};

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
  const [catalogue, setCatalogue] = useState<PluginCatalogue>(EMPTY_CATALOGUE);
  const [catalogueSearch, setCatalogueSearch] = useState('');
  const [catalogueBusy, setCatalogueBusy] = useState<string | null>(null);
  const [sourceDraft, setSourceDraft] = useState<PluginCatalogueSource>(EMPTY_SOURCE);
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
    void getPluginCatalogue().then(setCatalogue).catch((err) => {
      setError(rawMsg((err as Error).message));
    });
  }, [refresh]);

  const refreshCatalogue = async (network = false) => {
    setCatalogueBusy('refresh');
    try {
      setCatalogue(await getPluginCatalogue(network));
      setError(null);
    } catch (err) {
      setError(rawMsg((err as Error).message));
    } finally {
      setCatalogueBusy(null);
    }
  };

  const saveSources = async (sources: PluginCatalogueSource[]) => {
    setCatalogueBusy('sources');
    try {
      await savePluginCatalogueSources(sources);
      setCatalogue(await getPluginCatalogue());
      setError(null);
    } catch (err) {
      setError(rawMsg((err as Error).message));
    } finally {
      setCatalogueBusy(null);
    }
  };

  const addSource = async () => {
    if (!sourceDraft.id.trim() || !sourceDraft.url.trim() || !sourceDraft.public_key.trim()) return;
    await saveSources([
      ...catalogue.sources,
      {
        ...sourceDraft,
        id: sourceDraft.id.trim(),
        title: sourceDraft.title.trim() || sourceDraft.id.trim(),
        url: sourceDraft.url.trim(),
        public_key: sourceDraft.public_key.trim(),
        key_id: sourceDraft.key_id?.trim() || null,
      },
    ]);
    setSourceDraft(EMPTY_SOURCE);
  };

  const installFromCatalogue = async (item: PluginCatalogueItem, version?: string) => {
    setCatalogueBusy(item.id);
    try {
      await installCataloguePlugin(item.source, item.id, version);
      await Promise.all([refresh(), refreshCatalogue(false)]);
      setError(null);
    } catch (err) {
      setError(rawMsg((err as Error).message));
    } finally {
      setCatalogueBusy(null);
    }
  };

  const rollbackFromCatalogue = async (item: PluginCatalogueItem) => {
    setCatalogueBusy(item.id);
    try {
      await rollbackPlugin(item.id);
      await Promise.all([refresh(), refreshCatalogue(false)]);
      setError(null);
    } catch (err) {
      setError(rawMsg((err as Error).message));
    } finally {
      setCatalogueBusy(null);
    }
  };

  const visibleCatalogue = catalogue.items.filter((item) => {
    const query = catalogueSearch.trim().toLowerCase();
    return !query || [item.id, item.name, item.description, item.author, ...(item.categories ?? [])]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
  });

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

      <section className="plugin-marketplace" aria-label={t('plugins.catalogue')}>
        <div className="plugin-marketplace-heading">
          <strong>{t('plugins.catalogue')}</strong>
          <input
            value={catalogueSearch}
            onChange={(event) => setCatalogueSearch(event.target.value)}
            placeholder={t('plugins.catalogueSearch')}
            aria-label={t('plugins.catalogueSearch')}
          />
          <button disabled={catalogueBusy !== null} onClick={() => void refreshCatalogue(true)}>
            {catalogueBusy === 'refresh' ? t('common.loading') : t('plugins.catalogueRefresh')}
          </button>
        </div>
        {Object.entries(catalogue.errors).map(([source, message]) => (
          <div key={source} className="banner warning">{source}: {message}</div>
        ))}
        <details className="plugin-catalogue-sources">
          <summary>{t('plugins.catalogueSources')} ({catalogue.sources.length})</summary>
          {catalogue.sources.map((source) => (
            <div key={source.id} className="plugin-source-row">
              <span><strong>{source.title}</strong> <code>{source.id}</code></span>
              <span className="muted mono">{source.url}</span>
              <button
                className="danger"
                disabled={catalogueBusy !== null}
                onClick={() => void saveSources(catalogue.sources.filter((item) => item.id !== source.id))}
              >
                {t('common.delete')}
              </button>
            </div>
          ))}
          <div className="plugin-source-form">
            <input
              value={sourceDraft.id}
              onChange={(event) => setSourceDraft((current) => ({ ...current, id: event.target.value }))}
              placeholder={t('plugins.sourceId')}
              aria-label={t('plugins.sourceId')}
            />
            <input
              value={sourceDraft.title}
              onChange={(event) => setSourceDraft((current) => ({ ...current, title: event.target.value }))}
              placeholder={t('plugins.sourceTitle')}
              aria-label={t('plugins.sourceTitle')}
            />
            <input
              value={sourceDraft.url}
              onChange={(event) => setSourceDraft((current) => ({ ...current, url: event.target.value }))}
              placeholder={t('plugins.sourceUrl')}
              aria-label={t('plugins.sourceUrl')}
            />
            <input
              value={sourceDraft.public_key}
              onChange={(event) => setSourceDraft((current) => ({ ...current, public_key: event.target.value }))}
              placeholder={t('plugins.sourceKey')}
              aria-label={t('plugins.sourceKey')}
            />
            <input
              value={sourceDraft.key_id ?? ''}
              onChange={(event) => setSourceDraft((current) => ({ ...current, key_id: event.target.value }))}
              placeholder={t('plugins.sourceKeyId')}
              aria-label={t('plugins.sourceKeyId')}
            />
            <button disabled={catalogueBusy !== null} onClick={() => void addSource()}>
              {t('plugins.addSource')}
            </button>
          </div>
        </details>
        <div className="plugin-catalogue-grid">
          {visibleCatalogue.map((item) => (
            <article key={`${item.source}:${item.id}`} className="plugin-catalogue-card">
              <div>
                <strong>{item.name}</strong>
                <span className="muted mono"> {item.id}</span>
              </div>
              <p>{item.description}</p>
              <div className="plugin-catalogue-meta">
                <span>{item.source_title}</span>
                {item.author && <span>{item.author}</span>}
                {item.categories?.map((category) => <span key={category} className="param">{category}</span>)}
              </div>
              <div className="plugin-catalogue-actions">
                <span className="mono">
                  {item.installed_version
                    ? `${t('plugins.installed')} ${item.installed_version}`
                    : t('plugins.notInstalled')}
                  {item.latest_version && ` · ${t('plugins.latest')} ${item.latest_version}`}
                </span>
                {item.latest_version && (!item.installed_version || item.update_available) && (
                  <button
                    disabled={catalogueBusy !== null}
                    onClick={() => void installFromCatalogue(item, item.latest_version ?? undefined)}
                  >
                    {item.installed_version ? t('plugins.update') : t('plugins.installFromCatalogue')}
                  </button>
                )}
                {item.rollback_versions.length > 0 && (
                  <button
                    disabled={catalogueBusy !== null}
                    onClick={() => void rollbackFromCatalogue(item)}
                  >
                    {t('plugins.rollback')} {item.rollback_versions[0]}
                  </button>
                )}
              </div>
              {item.releases.some((release) => release.revoked) && (
                <small className="status-5xx">{t('plugins.revokedRelease')}</small>
              )}
            </article>
          ))}
          {catalogue.sources.length > 0 && visibleCatalogue.length === 0 && (
            <p className="muted">{t('plugins.catalogueNone')}</p>
          )}
        </div>
      </section>

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

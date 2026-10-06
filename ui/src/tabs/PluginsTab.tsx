import { useCallback, useEffect, useRef, useState } from 'react';

import {
  getPluginCatalogue,
  getPluginDiagnostics,
  getPluginSettings,
  installCataloguePlugin,
  installDevelopmentPlugin,
  installPluginPackage,
  installPluginSample,
  listPluginSamples,
  listPlugins,
  patchPluginSettings,
  reloadPlugin,
  resetPluginDiagnostics,
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
  PluginDiagnostics,
  PluginInfo,
  PluginSampleInfo,
  PluginSettingField,
  PluginSettings,
  PluginUiView,
} from '../api/types';
import { PluginFrame } from '../components/PluginFrame';
import { PluginLogConsole } from '../components/PluginLogConsole';
import { useReportBusy } from '../components/busy';
import { usePluginActions } from '../components/usePluginActions';
import { msg, rawMsg, renderMessage, useT, type Message } from '../i18n';

type Surface = 'installed' | 'catalogue';
type DetailTab = 'overview' | 'settings' | 'logs' | 'performance' | 'views';

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

function replacePlugin(items: PluginInfo[], updated: PluginInfo): PluginInfo[] {
  return items.map((item) => item.name === updated.name ? updated : item);
}

function CatalogueCard({ item, busy, onInstall, onRollback }: {
  item: PluginCatalogueItem;
  busy: boolean;
  onInstall: (item: PluginCatalogueItem, version?: string) => void;
  onRollback: (item: PluginCatalogueItem) => void;
}) {
  const t = useT();
  const [failedIcon, setFailedIcon] = useState<string | null>(null);

  return (
    <article className="plugin-catalogue-card">
      <header className="plugin-catalogue-card-header">
        <span className="plugin-catalogue-icon" aria-hidden="true">
          {item.icon && item.icon !== failedIcon ? <img src={item.icon} alt="" onError={() => setFailedIcon(item.icon ?? null)} /> : (
            <svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M12 5h8v6h6v16H6V11h6V5Zm0 12H6m20 0h-6v10" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /><circle cx="16" cy="16" r="2" fill="currentColor" /></svg>
          )}
        </span>
        <div><strong>{item.name}</strong><span className="muted mono">{item.id}</span></div>
      </header>
      <p>{item.description ?? t('plugins.noDescription')}</p>
      <div className="plugin-catalogue-meta"><span>{item.source_title}</span>{item.author && <span>{item.author}</span>}{item.categories?.map((category) => <span key={category} className="param">{category}</span>)}</div>
      <div className="plugin-catalogue-actions">
        <span className="mono">{item.installed_version ? `${t('plugins.installed')} ${item.installed_version}` : t('plugins.notInstalled')}{item.latest_version && ` · ${t('plugins.latest')} ${item.latest_version}`}</span>
        {item.latest_version && (!item.installed_version || item.update_available) && <button disabled={busy} onClick={() => onInstall(item, item.latest_version ?? undefined)}>{item.installed_version ? t('plugins.update') : t('plugins.installFromCatalogue')}</button>}
        {item.rollback_versions.length > 0 && <button disabled={busy} onClick={() => onRollback(item)}>{t('plugins.rollback')} {item.rollback_versions[0]}</button>}
      </div>
      {item.releases.some((release) => release.revoked) && <small className="status-5xx">{t('plugins.revokedRelease')}</small>}
      <details className="plugin-catalogue-more">
        <summary>{t('plugins.more')}</summary>
        <div className="plugin-catalogue-more-content">
          {item.details && <p>{item.details}</p>}
          {item.homepage && <a href={item.homepage} target="_blank" rel="noopener noreferrer">{t('plugins.homepage')}</a>}
          <h4>{t('plugins.releases')}</h4>
          <ul>{item.releases.map((release) => <li key={release.version}>
            <strong>v{release.version}</strong>
            {release.published_at && <span className="muted">{release.published_at.slice(0, 10)}</span>}
            {release.revoked ? <span className="status-5xx">{t('plugins.releaseRevoked')}{release.revocation_reason && `: ${release.revocation_reason}`}</span> : release.yanked ? <span className="muted">{t('plugins.releaseYanked')}</span> : !release.compatible && <span className="muted">{t('plugins.releaseIncompatible')}</span>}
            <small className="muted">Lanius {release.compatibility.lanius} · SDK {release.compatibility.sdk}</small>
          </li>)}</ul>
        </div>
      </details>
    </article>
  );
}

export function PluginsTab() {
  const t = useT();
  const [surface, setSurface] = useState<Surface>('installed');
  const [detailTab, setDetailTab] = useState<DetailTab>('overview');
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [directory, setDirectory] = useState('');
  const [safeMode, setSafeMode] = useState(false);
  const [suspended, setSuspended] = useState(false);
  const [suspendedReason, setSuspendedReason] = useState<string | null>(null);
  const [developmentMode, setDevelopmentMode] = useState(false);
  const [developmentPath, setDevelopmentPath] = useState('');
  const [error, setError] = useState<Message | null>(null);
  const [operationErrors, setOperationErrors] = useState<Record<string, string>>({});
  const [busyPlugin, setBusyPlugin] = useState<string | null>(null);
  const [settings, setSettings] = useState<PluginSettings | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<Record<string, unknown>>({});
  const [savingSettings, setSavingSettings] = useState(false);
  const [diagnostics, setDiagnostics] = useState<PluginDiagnostics | null>(null);
  const [activeView, setActiveView] = useState<{ plugin: PluginInfo; view: PluginUiView } | null>(null);
  const [samples, setSamples] = useState<PluginSampleInfo[]>([]);
  const [sampleBusy, setSampleBusy] = useState<string | null>(null);
  const [catalogue, setCatalogue] = useState<PluginCatalogue>(EMPTY_CATALOGUE);
  const [catalogueLoading, setCatalogueLoading] = useState(true);
  const [catalogueSearch, setCatalogueSearch] = useState('');
  const [catalogueBusy, setCatalogueBusy] = useState<string | null>(null);
  const [sourceDraft, setSourceDraft] = useState<PluginCatalogueSource>(EMPTY_SOURCE);
  const [loading, setLoading] = useState(true);
  const packageInput = useRef<HTMLInputElement | null>(null);
  const sourcesPanel = useRef<HTMLDetailsElement | null>(null);
  useReportBusy('plugins', loading);
  const {
    actionsAt,
    invoke: invokeAction,
    refresh: refreshActions,
  } = usePluginActions((message) => setError(rawMsg(message)));

  const refreshSamples = useCallback(async () => {
    try {
      setSamples((await listPluginSamples()).items);
    } catch (reason) {
      setError(rawMsg((reason as Error).message));
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const data = await listPlugins();
      setPlugins(data.items);
      setDirectory(data.directory);
      setSafeMode(data.safe_mode);
      setSuspended(data.suspended);
      setSuspendedReason(data.suspended_reason);
      setDevelopmentMode(data.development_mode);
      setSelectedName((current) => (
        current && data.items.some((plugin) => plugin.name === current)
          ? current
          : data.items[0]?.name ?? null
      ));
      await refreshActions();
    } catch (reason) {
      setError(msg('plugins.listFailed', { message: (reason as Error).message }));
    } finally {
      setLoading(false);
    }
  }, [refreshActions]);

  useEffect(() => {
    void refresh();
    void refreshSamples();
    void getPluginCatalogue().then(setCatalogue).catch((reason) => {
      setError(rawMsg((reason as Error).message));
    }).finally(() => setCatalogueLoading(false));
  }, [refresh, refreshSamples]);

  const selected = plugins.find((plugin) => plugin.name === selectedName) ?? null;

  const selectPlugin = (name: string) => {
    setSelectedName(name);
    setDetailTab('overview');
    setSettings(null);
    setDiagnostics(null);
  };

  const setPluginError = (name: string, message: string | null) => {
    setOperationErrors((current) => {
      const next = { ...current };
      if (message) next[name] = message;
      else delete next[name];
      return next;
    });
  };

  const toggle = async (plugin: PluginInfo) => {
    setBusyPlugin(plugin.name);
    try {
      const updated = await setPluginEnabled(plugin.name, !plugin.enabled);
      setPlugins((current) => replacePlugin(current, updated));
      setPluginError(plugin.name, null);
      await refreshActions();
    } catch (reason) {
      setPluginError(plugin.name, (reason as Error).message);
    } finally {
      setBusyPlugin(null);
    }
  };

  const reload = async (plugin: PluginInfo) => {
    setBusyPlugin(plugin.name);
    try {
      const updated = await reloadPlugin(plugin.name);
      setPlugins((current) => replacePlugin(current, updated));
      setPluginError(plugin.name, null);
      await refreshActions();
    } catch (reason) {
      setPluginError(plugin.name, (reason as Error).message);
    } finally {
      setBusyPlugin(null);
    }
  };

  const move = async (plugin: PluginInfo, offset: number) => {
    const names = plugins.map((item) => item.name);
    const index = names.indexOf(plugin.name);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= names.length) return;
    [names[index], names[target]] = [names[target], names[index]];
    setBusyPlugin(plugin.name);
    try {
      setPlugins((await setPluginOrder(names)).items);
      setPluginError(plugin.name, null);
    } catch (reason) {
      setPluginError(plugin.name, (reason as Error).message);
    } finally {
      setBusyPlugin(null);
    }
  };

  const toggleAutoReload = async (plugin: PluginInfo) => {
    setBusyPlugin(plugin.name);
    try {
      const updated = await setPluginAutoReload(plugin.name, !plugin.auto_reload);
      setPlugins((current) => replacePlugin(current, updated));
      setPluginError(plugin.name, null);
    } catch (reason) {
      setPluginError(plugin.name, (reason as Error).message);
    } finally {
      setBusyPlugin(null);
    }
  };

  const selectDetailTab = async (tab: DetailTab) => {
    setDetailTab(tab);
    if (!selected) return;
    try {
      if (tab === 'settings') {
        const data = await getPluginSettings(selected.name);
        setSettings(data);
        setSettingsDraft(data.values);
      } else if (tab === 'performance') {
        setDiagnostics(await getPluginDiagnostics(selected.name));
      }
      setPluginError(selected.name, null);
    } catch (reason) {
      setPluginError(selected.name, (reason as Error).message);
    }
  };

  const saveSettings = async () => {
    if (!settings) return;
    setSavingSettings(true);
    try {
      const data = await patchPluginSettings(settings.plugin, settingsDraft);
      setSettings(data);
      setSettingsDraft(data.values);
      setPluginError(settings.plugin, null);
    } catch (reason) {
      setPluginError(settings.plugin, (reason as Error).message);
    } finally {
      setSavingSettings(false);
    }
  };

  const clearDiagnostics = async () => {
    if (!diagnostics) return;
    try {
      setDiagnostics(await resetPluginDiagnostics(diagnostics.plugin));
      setPluginError(diagnostics.plugin, null);
    } catch (reason) {
      setPluginError(diagnostics.plugin, (reason as Error).message);
    }
  };

  const changeSetting = (field: PluginSettingField, value: unknown) => {
    setSettingsDraft((current) => ({ ...current, [field.key]: value }));
  };

  const installPackage = async (file: File) => {
    try {
      const result = await installPluginPackage(file);
      await Promise.all([refresh(), refreshSamples()]);
      setSelectedName(result.plugin.name);
      setSurface('installed');
      setError(null);
    } catch (reason) {
      setError(rawMsg((reason as Error).message));
    } finally {
      if (packageInput.current) packageInput.current.value = '';
    }
  };

  const installSample = async (sample: PluginSampleInfo) => {
    setSampleBusy(sample.id);
    try {
      const result = await installPluginSample(sample.id);
      await Promise.all([refresh(), refreshSamples()]);
      setSelectedName(result.plugin.name);
      setSurface('installed');
      setError(null);
    } catch (reason) {
      setError(rawMsg((reason as Error).message));
    } finally {
      setSampleBusy(null);
    }
  };

  const installDevelopment = async () => {
    if (!developmentPath.trim()) return;
    try {
      const result = await installDevelopmentPlugin(developmentPath.trim());
      setDevelopmentPath('');
      await refresh();
      setSelectedName(result.plugin.name);
      setError(null);
    } catch (reason) {
      setError(rawMsg((reason as Error).message));
    }
  };

  const uninstall = async (plugin: PluginInfo) => {
    setBusyPlugin(plugin.name);
    try {
      await uninstallPluginPackage(plugin.name);
      if (activeView?.plugin.name === plugin.name) setActiveView(null);
      await Promise.all([refresh(), refreshSamples()]);
      setError(null);
    } catch (reason) {
      setPluginError(plugin.name, (reason as Error).message);
    } finally {
      setBusyPlugin(null);
    }
  };

  const copyDirectory = async () => {
    try {
      await navigator.clipboard.writeText(directory);
      setError(null);
    } catch (reason) {
      setError(rawMsg((reason as Error).message));
    }
  };

  const refreshCatalogue = async (network = false) => {
    setCatalogueBusy('refresh');
    try {
      setCatalogue(await getPluginCatalogue(network));
      setError(null);
    } catch (reason) {
      setError(rawMsg((reason as Error).message));
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
    } catch (reason) {
      setError(rawMsg((reason as Error).message));
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
      const result = await installCataloguePlugin(item.source, item.id, version);
      await Promise.all([refresh(), refreshCatalogue(false), refreshSamples()]);
      setSelectedName(result.plugin.name);
      setSurface('installed');
      setError(null);
    } catch (reason) {
      setError(rawMsg((reason as Error).message));
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
    } catch (reason) {
      setError(rawMsg((reason as Error).message));
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
  const enabledSources = catalogue.sources.filter((source) => source.enabled);
  const noActiveSources = enabledSources.length === 0;
  const missingCache = enabledSources.some((source) =>
    catalogue.errors[source.id]?.startsWith('catalogue has not been refreshed:'));
  const catalogueEmpty = catalogue.items.length === 0;
  const firstRefresh = catalogueEmpty && enabledSources.length > 0 && missingCache && !catalogue.refreshed;
  const catalogueFailed = catalogueEmpty && Object.values(catalogue.errors).some((message) =>
    catalogue.refreshed || !message.startsWith('catalogue has not been refreshed:'));
  const catalogueErrors = Object.entries(catalogue.errors).filter(([, message]) =>
    catalogue.refreshed || !message.startsWith('catalogue has not been refreshed:'));
  const showSources = () => {
    if (!sourcesPanel.current) return;
    sourcesPanel.current.open = true;
    sourcesPanel.current.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
  };

  const status = (plugin: PluginInfo) => {
    if (plugin.error || operationErrors[plugin.name]) return t('plugins.statusError');
    if (plugin.enabled && plugin.loaded) return t('plugins.statusRunning');
    if (plugin.enabled && suspended) return t('plugins.statusSuspended');
    if (plugin.enabled) return t('plugins.statusIdle');
    return t('plugins.statusOff');
  };

  const contributionEntries = (plugin: PluginInfo) => [
    [t('plugins.contribActions'), plugin.contributions.actions],
    [t('plugins.contribCodecs'), plugin.contributions.codecs],
    [t('plugins.contribGenerators'), plugin.contributions.payload_generators],
    [t('plugins.contribProcessors'), plugin.contributions.payload_processors],
    [t('plugins.contribSettings'), plugin.contributions.settings],
    [t('plugins.contribPassive'), plugin.contributions.passive_scanners],
    [t('plugins.contribActive'), plugin.contributions.active_scanners],
  ].filter((entry) => Number(entry[1]) > 0);

  return (
    <div className="plugins-tab">
      <header className="plugins-header">
        <nav className="plugin-surface-tabs" aria-label={t('plugins.sections')}>
          <button className={surface === 'installed' ? 'active' : ''} onClick={() => setSurface('installed')}>
            {t('plugins.installedTab')} <span>{plugins.length}</span>
          </button>
          <button className={surface === 'catalogue' ? 'active' : ''} onClick={() => setSurface('catalogue')}>
            {t('plugins.catalogue')}
          </button>
        </nav>
        <span className="spacer" />
        {actionsAt(['global']).map((action) => (
          <button key={action.id} title={action.description ?? undefined} onClick={() => void invokeAction(action, { location: 'global' })}>
            {action.title}
          </button>
        ))}
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
      </header>

      {(safeMode || suspended) && <div className="banner warning">{suspendedReason ?? t('plugins.safeMode')}</div>}
      {error && <div className="banner error">{renderMessage(error, t)}</div>}

      {surface === 'installed' ? (
        plugins.length === 0 ? (
          <section className="plugin-onboarding" aria-label={t('plugins.emptyTitle')}>
            <div className="plugin-onboarding-copy">
              <span className="plugin-onboarding-icon">⌁</span>
              <h2>{t('plugins.emptyTitle')}</h2>
              <p>{t('plugins.emptyHelp')}</p>
              <div className="plugin-directory-card">
                <span>{t('plugins.directory')}</span>
                <code>{directory}</code>
                <button onClick={() => void copyDirectory()}>{t('plugins.copyPath')}</button>
              </div>
              <div className="plugin-onboarding-actions">
                <button className="primary" onClick={() => packageInput.current?.click()}>{t('plugins.install')}</button>
                <button onClick={() => void refresh()}>{t('plugins.rescan')}</button>
              </div>
              <p className="muted">{t('plugins.fileHelp')}</p>
            </div>
            <div className="plugin-sample-grid">
              <h3>{t('plugins.samples')}</h3>
              {samples.map((sample) => (
                <article key={sample.id} className="plugin-sample-card">
                  <div><strong>{sample.name}</strong> <span className="muted">v{sample.version}</span></div>
                  <p>{sample.description}</p>
                  <small className="muted">{sample.author}</small>
                  <button disabled={sampleBusy !== null || sample.installed} onClick={() => void installSample(sample)}>
                    {sample.installed ? t('plugins.installed') : sampleBusy === sample.id ? t('common.loading') : t('plugins.installSample')}
                  </button>
                </article>
              ))}
            </div>
            {developmentMode && (
              <div className="plugin-development-link">
                <input aria-label={t('plugins.developmentPath')} placeholder={t('plugins.developmentPath')} value={developmentPath} onChange={(event) => setDevelopmentPath(event.target.value)} />
                <button onClick={() => void installDevelopment()}>{t('plugins.linkDevelopment')}</button>
              </div>
            )}
          </section>
        ) : (
          <div className="plugin-manager">
            <aside className="plugin-list-pane">
              <div className="plugin-list-heading"><strong>{t('plugins.installedTab')}</strong><span>{plugins.length}</span></div>
              <div className="plugin-list">
                {plugins.map((plugin) => (
                  <article key={plugin.name} className={`plugin-list-item${selectedName === plugin.name ? ' selected' : ''}${plugin.error || operationErrors[plugin.name] ? ' has-error' : ''}`}>
                    <button className="plugin-list-select" onClick={() => selectPlugin(plugin.name)}>
                      <span className="plugin-list-title"><strong>{plugin.package?.name ?? plugin.name}</strong>{plugin.version && <small>v{plugin.version}</small>}</span>
                      <span className="plugin-status">{busyPlugin === plugin.name ? t('plugins.statusChanging') : status(plugin)}</span>
                      <span className="plugin-list-description">{plugin.description ?? t('common.none')}</span>
                      <span className="plugin-list-meta">
                        {plugin.package && <span className={`plugin-trust plugin-trust-${plugin.package.trust}`}>{plugin.package.trust}</span>}
                        {operationErrors[plugin.name] && <span className="status-5xx">{operationErrors[plugin.name]}</span>}
                      </span>
                    </button>
                    <label className="plugin-switch">
                      <input type="checkbox" role="switch" aria-label={t('plugins.toggleLabel', { name: plugin.name })} checked={plugin.enabled} disabled={busyPlugin === plugin.name || (suspended && !plugin.enabled)} onChange={() => void toggle(plugin)} />
                      <span />
                    </label>
                  </article>
                ))}
              </div>
              <footer><code title={directory}>{directory}</code><button aria-label={t('plugins.copyPath')} onClick={() => void copyDirectory()}>⧉</button></footer>
            </aside>

            <main className="plugin-detail-pane">
              {selected && (
                <>
                  <header className="plugin-detail-header">
                    <div><h2>{selected.package?.name ?? selected.name}</h2><span className="mono muted">{selected.name}{selected.version ? ` · ${selected.version}` : ''}</span></div>
                    <span className={`plugin-detail-status ${selected.error || operationErrors[selected.name] ? 'error' : selected.loaded ? 'running' : ''}`}>{busyPlugin === selected.name ? t('plugins.statusChanging') : status(selected)}</span>
                    <label className="plugin-switch large">
                      <input type="checkbox" role="switch" aria-label={t('plugins.detailToggleLabel', { name: selected.name })} checked={selected.enabled} disabled={busyPlugin === selected.name || (suspended && !selected.enabled)} onChange={() => void toggle(selected)} />
                      <span />
                    </label>
                  </header>
                  {(selected.error || operationErrors[selected.name]) && <div className="banner error mono">{operationErrors[selected.name] ?? selected.error}</div>}
                  <nav className="plugin-detail-tabs" aria-label={t('plugins.detailSections')}>
                    {(['overview', 'settings', 'logs', 'performance', 'views'] as DetailTab[]).map((tab) => (
                      <button key={tab} className={detailTab === tab ? 'active' : ''} onClick={() => void selectDetailTab(tab)}>
                        {t(`plugins.detail.${tab}`)}{tab === 'views' && selected.ui?.views.length ? ` (${selected.ui.views.length})` : ''}
                      </button>
                    ))}
                  </nav>

                  <div className="plugin-detail-content">
                    {detailTab === 'overview' && (
                      <section className="plugin-overview">
                        <p className="plugin-description">{selected.description ?? t('plugins.noDescription')}</p>
                        <dl className="plugin-facts">
                          <div><dt>{t('common.status')}</dt><dd>{status(selected)}</dd></div>
                          <div><dt>{t('plugins.author')}</dt><dd>{selected.author ?? t('common.none')}</dd></div>
                          <div><dt>{t('plugins.source')}</dt><dd>{selected.package?.source ?? t('plugins.looseFile')}</dd></div>
                          <div><dt>{t('plugins.trust')}</dt><dd>{selected.package?.trust ?? t('plugins.unmanaged')}</dd></div>
                          <div className="wide"><dt>{t('common.location')}</dt><dd><code>{selected.path}</code></dd></div>
                        </dl>
                        <div className="plugin-detail-section">
                          <h3>{t('plugins.runtime')}</h3>
                          <label><input type="checkbox" checked={selected.auto_reload} disabled={busyPlugin === selected.name} onChange={() => void toggleAutoReload(selected)} /> {t('plugins.autoReload')}</label>
                          <div className="plugin-inline-actions">
                            <button disabled={selected.order === 0 || busyPlugin === selected.name} onClick={() => void move(selected, -1)}>↑ {t('plugins.moveUp')}</button>
                            <button disabled={selected.order === plugins.length - 1 || busyPlugin === selected.name} onClick={() => void move(selected, 1)}>↓ {t('plugins.moveDown')}</button>
                            <button disabled={busyPlugin === selected.name || suspended} onClick={() => void reload(selected)}>{t('plugins.reload')}</button>
                            {selected.package && <button className="danger" disabled={busyPlugin === selected.name} onClick={() => void uninstall(selected)}>{t('plugins.uninstall')}</button>}
                          </div>
                        </div>
                        <div className="plugin-detail-section"><h3>{t('plugins.hooks')}</h3><div className="plugin-chip-list">{selected.hooks.map((hook) => <span key={hook} className="param">{hook}</span>)}{selected.hooks.length === 0 && <span className="muted">{t('common.none')}</span>}</div></div>
                        <div className="plugin-detail-section">
                          <h3>{t('plugins.contributions')}</h3>
                          <div className="plugin-contribution-grid">{contributionEntries(selected).map(([label, count]) => <div key={String(label)}><strong>{String(count)}</strong><span>{label}</span></div>)}{contributionEntries(selected).length === 0 && <span className="muted">{t('common.none')}</span>}</div>
                        </div>
                        {selected.package && <div className="plugin-detail-section"><h3>{t('plugins.permissions')}</h3><div className="plugin-chip-list">{selected.package.permissions.map((permission) => <code key={permission}>{permission}</code>)}{selected.package.permissions.length === 0 && <span className="muted">{t('common.none')}</span>}</div></div>}
                      </section>
                    )}

                    {detailTab === 'settings' && (
                      <section className="plugin-settings-panel" aria-label={t('plugins.settingsFor', { name: selected.name })}>
                        {!selected.loaded && <p className="muted">{t('plugins.enableForSettings')}</p>}
                        {settings?.plugin === selected.name && settings.fields.map((field) => (
                          <label key={field.key} className="plugin-setting-field">
                            <span>{field.title}<small>{field.scope === 'user' ? t('plugins.userScope') : t('plugins.projectScope')}</small></span>
                            {field.kind === 'boolean' ? <input type="checkbox" checked={Boolean(settingsDraft[field.key])} onChange={(event) => changeSetting(field, event.target.checked)} /> : field.kind === 'enum' ? <select value={String(settingsDraft[field.key] ?? '')} onChange={(event) => changeSetting(field, event.target.value)}>{field.choices.map((choice) => <option key={choice}>{choice}</option>)}</select> : <input type={field.kind === 'integer' || field.kind === 'number' ? 'number' : 'text'} step={field.kind === 'integer' ? 1 : field.kind === 'number' ? 'any' : undefined} value={String(settingsDraft[field.key] ?? '')} onChange={(event) => changeSetting(field, field.kind === 'integer' || field.kind === 'number' ? Number(event.target.value) : event.target.value)} />}
                            {field.description && <small className="muted">{field.description}</small>}
                          </label>
                        ))}
                        {settings?.plugin === selected.name && settings.fields.length === 0 && selected.loaded && <p className="muted">{t('plugins.noSettings')}</p>}
                        {settings?.plugin === selected.name && settings.fields.length > 0 && <button className="primary" disabled={savingSettings} onClick={() => void saveSettings()}>{savingSettings ? t('plugins.savingSettings') : t('plugins.saveSettings')}</button>}
                      </section>
                    )}

                    {detailTab === 'logs' && <PluginLogConsole key={selected.name} plugin={selected.name} />}

                    {detailTab === 'performance' && (
                      <section className="plugin-performance" aria-label={t('plugins.diagnosticsFor', { name: selected.name })}>
                        <div className="plugin-section-heading"><div><h3>{t('plugins.performance')}</h3><p className="muted">{t('plugins.performanceHelp')}</p></div><button onClick={() => void clearDiagnostics()}>{t('plugins.resetDiagnostics')}</button></div>
                        {diagnostics?.plugin === selected.name && diagnostics.contributions.length > 0 ? (
                          <table><thead><tr><th>{t('common.name')}</th><th>{t('plugins.calls')}</th><th>{t('common.error')}</th><th>{t('plugins.average')}</th><th>{t('plugins.maximum')}</th><th>{t('common.status')}</th></tr></thead><tbody>{diagnostics.contributions.map((item) => <tr key={`${item.kind}:${item.id}`}><td>{item.id}</td><td>{item.calls}</td><td>{item.errors}</td><td>{item.average_ms.toFixed(1)} ms</td><td>{item.max_ms.toFixed(1)} ms</td><td>{item.suspended ? t('plugins.suspended') : t('plugins.active')}</td></tr>)}</tbody></table>
                        ) : <p className="muted">{t('plugins.noDiagnostics')}</p>}
                      </section>
                    )}

                    {detailTab === 'views' && (
                      <section className="plugin-views">
                        {selected.ui?.views.map((view) => <article key={view.id}><div><strong>{view.title}</strong><code>{view.entrypoint}</code></div><button disabled={!selected.loaded} onClick={() => setActiveView({ plugin: selected, view })}>{t('plugins.openView')}</button></article>)}
                        {!selected.ui?.views.length && <p className="muted">{t('plugins.noViews')}</p>}
                      </section>
                    )}
                  </div>
                </>
              )}
            </main>
          </div>
        )
      ) : (
        <section className="plugin-marketplace" aria-label={t('plugins.catalogue')}>
          <div className="plugin-marketplace-heading">
            <div>
              <h2>{t('plugins.catalogue')}</h2>
              <p className="muted">{t('plugins.catalogueHelp')}</p>
            </div>
            {!catalogueEmpty && <div className="plugin-marketplace-tools">
              <input value={catalogueSearch} onChange={(event) => setCatalogueSearch(event.target.value)} placeholder={t('plugins.catalogueSearch')} aria-label={t('plugins.catalogueSearch')} />
              <button disabled={catalogueBusy !== null} onClick={() => void refreshCatalogue(true)}>{catalogueBusy === 'refresh' ? t('common.loading') : t('plugins.catalogueRefresh')}</button>
            </div>}
          </div>
          {catalogueErrors.map(([source, message]) => <div key={source} className="banner warn">{source}: {message}</div>)}
          {catalogueLoading ? <div className="plugin-catalogue-loading">{t('common.loading')}</div> : catalogueEmpty ? <div className="plugin-catalogue-empty">
            <div className="plugin-catalogue-empty-icon" aria-hidden="true">
              <svg viewBox="0 0 64 64" fill="none"><rect x="12" y="11" width="40" height="42" rx="8" stroke="currentColor" strokeWidth="2"/><path d="M21 24h22M21 31h14M21 38h11" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="m39 40 4 4 7-8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </div>
            <div className="plugin-catalogue-empty-copy">
              <span className="plugin-catalogue-kicker">{t('plugins.catalogueSourceCount', { count: String(enabledSources.length) })}</span>
              <h3>{noActiveSources ? t('plugins.catalogueNoSourcesTitle') : catalogueFailed ? t('plugins.catalogueFailedTitle') : firstRefresh ? t('plugins.catalogueFirstTitle') : t('plugins.catalogueNoPluginsTitle')}</h3>
              <p>{noActiveSources ? t('plugins.catalogueNoSourcesHelp') : catalogueFailed ? t('plugins.catalogueFailedHelp') : firstRefresh ? t('plugins.catalogueFirstHelp') : t('plugins.catalogueNoPluginsHelp')}</p>
              <div className="plugin-catalogue-empty-actions">
                {!noActiveSources && <button className="primary" disabled={catalogueBusy !== null} onClick={() => void refreshCatalogue(true)}>{catalogueBusy === 'refresh' ? t('common.loading') : t('plugins.catalogueRefresh')}</button>}
                <button onClick={showSources}>{t('plugins.catalogueManageSources')}</button>
              </div>
            </div>
          </div> : visibleCatalogue.length === 0 ? <div className="plugin-catalogue-no-match">{t('plugins.catalogueNone')}</div> : <div className="plugin-catalogue-grid">
            {visibleCatalogue.map((item) => <CatalogueCard key={`${item.source}:${item.id}`} item={item} busy={catalogueBusy !== null} onInstall={(plugin, version) => void installFromCatalogue(plugin, version)} onRollback={(plugin) => void rollbackFromCatalogue(plugin)} />)}
          </div>}
          <details ref={sourcesPanel} className="plugin-catalogue-sources">
            <summary>{t('plugins.catalogueSources')} ({catalogue.sources.length})</summary>
            {catalogue.sources.map((source) => <div key={source.id} className="plugin-source-row"><span><strong>{source.title}</strong> <code>{source.id}</code></span><span className="muted mono">{source.url}</span><button className="danger" disabled={catalogueBusy !== null} onClick={() => void saveSources(catalogue.sources.filter((item) => item.id !== source.id))}>{t('common.delete')}</button></div>)}
            <div className="plugin-source-form">
              <input value={sourceDraft.id} onChange={(event) => setSourceDraft((current) => ({ ...current, id: event.target.value }))} placeholder={t('plugins.sourceId')} aria-label={t('plugins.sourceId')} />
              <input value={sourceDraft.title} onChange={(event) => setSourceDraft((current) => ({ ...current, title: event.target.value }))} placeholder={t('plugins.sourceTitle')} aria-label={t('plugins.sourceTitle')} />
              <input value={sourceDraft.url} onChange={(event) => setSourceDraft((current) => ({ ...current, url: event.target.value }))} placeholder={t('plugins.sourceUrl')} aria-label={t('plugins.sourceUrl')} />
              <input value={sourceDraft.public_key} onChange={(event) => setSourceDraft((current) => ({ ...current, public_key: event.target.value }))} placeholder={t('plugins.sourceKey')} aria-label={t('plugins.sourceKey')} />
              <input value={sourceDraft.key_id ?? ''} onChange={(event) => setSourceDraft((current) => ({ ...current, key_id: event.target.value }))} placeholder={t('plugins.sourceKeyId')} aria-label={t('plugins.sourceKeyId')} />
              <button disabled={catalogueBusy !== null} onClick={() => void addSource()}>{t('plugins.addSource')}</button>
            </div>
          </details>
        </section>
      )}

      {activeView && <PluginFrame plugin={activeView.plugin} view={activeView.view} onClose={() => setActiveView(null)} />}
    </div>
  );
}

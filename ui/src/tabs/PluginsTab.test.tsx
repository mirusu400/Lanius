/** Plugin management workspace rendered against a mocked engine. */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PluginCatalogue, PluginInfo, PluginSampleInfo } from '../api/types';
import { renderWithI18n as render, t } from '../test-utils';
import { PluginsTab } from './PluginsTab';

let plugins: PluginInfo[] = [];
let calls: string[] = [];
let suspended = false;
let catalogue: PluginCatalogue;
let samples: PluginSampleInfo[] = [];
let releaseEnable: (() => void) | null = null;

const base: PluginInfo = {
  name: 'stamp',
  path: '/p/stamp.py',
  enabled: false,
  loaded: false,
  error: null,
  description: 'adds a header',
  version: '1.0.0',
  author: 'tester',
  hooks: ['request'],
  order: 0,
  auto_reload: false,
  sdk_api_version: null,
  contributions: {},
  package: null,
  ui: null,
};

function jsonResponse(body: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 400,
    statusText: ok ? 'OK' : 'Bad Request',
    json: async () => body,
  } as Response;
}

function installedSample(): PluginInfo {
  return {
    ...base,
    name: 'lanius.request-marker',
    path: '/plugins/lanius.request-marker/backend/__init__.py',
    description: 'Sample marker',
    author: 'Lanius',
    package: {
      schema: 1,
      id: 'lanius.request-marker',
      name: 'Request Marker',
      permissions: ['actions.invoke', 'settings.read'],
      signature_present: false,
      trust: 'unsigned',
      development: false,
      source: 'bundled',
      catalog_source: null,
    },
    ui: { views: [{ id: 'dashboard', title: 'Request Marker', entrypoint: 'ui/index.html' }] },
  };
}

beforeEach(() => {
  calls = [];
  suspended = false;
  releaseEnable = null;
  catalogue = { sources: [], items: [], errors: {}, refreshed: false };
  samples = [{
    id: 'lanius.request-marker',
    name: 'Request Marker',
    version: '1.0.0',
    description: 'Marks requests',
    author: 'Lanius',
    installed: false,
    installed_version: null,
  }];
  plugins = [
    { ...base },
    { ...base, name: 'broken', description: null, version: '2.0.0', hooks: [], error: 'RuntimeError: boom', order: 1 },
  ];

  vi.stubGlobal('navigator', {
    ...navigator,
    clipboard: { writeText: vi.fn(async () => undefined) },
  });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/api/plugins')) {
      return jsonResponse({
        items: plugins,
        directory: '/home/u/.lanius/plugins',
        safe_mode: false,
        suspended,
        suspended_reason: suspended ? 'Lockdown Mode blocks plugin execution' : null,
        development_mode: false,
      });
    }
    if (url.endsWith('/api/plugin-samples')) return jsonResponse({ items: samples });
    if (url.endsWith('/api/plugin-contributions')) return jsonResponse({ actions: [] });
    if (url.includes('/api/plugin-catalogue?')) return jsonResponse(catalogue);
    if (url.endsWith('/api/plugins/order')) {
      const names = JSON.parse(String(init?.body)) as string[];
      plugins = names.map((name, order) => ({ ...plugins.find((plugin) => plugin.name === name)!, order }));
      return jsonResponse({ items: plugins });
    }
    if (url.endsWith('/api/plugins/stamp/settings')) {
      const enabled = init?.method === 'PATCH'
        ? Boolean((JSON.parse(String(init.body)) as { values: { enabled: boolean } }).values.enabled)
        : true;
      return jsonResponse({
        plugin: 'stamp',
        fields: [{
          key: 'enabled', title: 'Feature enabled', kind: 'boolean',
          default: true, description: 'Controls the feature', scope: 'project', choices: [],
        }],
        values: { enabled },
      });
    }
    if (url.endsWith('/api/plugins/stamp/diagnostics/reset')) {
      return jsonResponse({ plugin: 'stamp', contributions: [], logs: [] });
    }
    if (url.endsWith('/api/plugins/stamp/diagnostics')) {
      return jsonResponse({
        plugin: 'stamp',
        contributions: [{
          id: 'stamp.inspect', kind: 'actions', title: 'Inspect', calls: 4,
          errors: 1, total_ms: 10, average_ms: 2.5, max_ms: 5, last_ms: 2,
          last_called_at: 1, last_error: 'RuntimeError: failed', consecutive_errors: 0, suspended: false,
        }],
        logs: [],
      });
    }
    if (url.includes('/auto-reload')) {
      const name = url.split('/api/plugins/')[1].split('/')[0];
      const enabled = url.endsWith('enabled=true');
      plugins = plugins.map((plugin) => plugin.name === name ? { ...plugin, auto_reload: enabled } : plugin);
      return jsonResponse(plugins.find((plugin) => plugin.name === name));
    }
    if (url.endsWith('/api/plugin-samples/lanius.request-marker/install')) {
      const plugin = installedSample();
      plugins = [plugin];
      samples = samples.map((sample) => ({ ...sample, installed: true, installed_version: '1.0.0' }));
      return jsonResponse({ plugin });
    }
    if (url.endsWith('/api/plugin-catalogue/install')) {
      const plugin = { ...base, name: 'acme.scanner' };
      plugins = [...plugins, plugin];
      return jsonResponse({ plugin });
    }
    if (url.includes('/broken/enable')) return jsonResponse({ detail: 'RuntimeError: boom' }, false);
    if (url.includes('/stamp/enable')) {
      if (releaseEnable === null) {
        plugins = plugins.map((plugin) => plugin.name === 'stamp' ? { ...plugin, enabled: true, loaded: true } : plugin);
        return jsonResponse(plugins.find((plugin) => plugin.name === 'stamp'));
      }
      await new Promise<void>((resolve) => { releaseEnable = resolve; });
      plugins = plugins.map((plugin) => plugin.name === 'stamp' ? { ...plugin, enabled: true, loaded: true } : plugin);
      return jsonResponse(plugins.find((plugin) => plugin.name === 'stamp'));
    }
    if (url.includes('/disable')) {
      const name = url.split('/api/plugins/')[1].split('/')[0];
      plugins = plugins.map((plugin) => plugin.name === name ? { ...plugin, enabled: false, loaded: false } : plugin);
      return jsonResponse(plugins.find((plugin) => plugin.name === name));
    }
    if (url.includes('/reload')) {
      const name = url.split('/api/plugins/')[1].split('/')[0];
      return jsonResponse(plugins.find((plugin) => plugin.name === name));
    }
    return jsonResponse({});
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PluginsTab', () => {
  it('renders a compact installed list and selected plugin details', async () => {
    render(<PluginsTab />);
    expect(await screen.findByTitle('/home/u/.lanius/plugins')).toBeTruthy();
    expect(screen.getAllByText('adds a header')).toHaveLength(2);
    expect(screen.getByText('/p/stamp.py')).toBeTruthy();
    expect(screen.getByText('request')).toBeTruthy();
    expect(screen.getAllByText(t('plugins.statusOff')).length).toBeGreaterThan(0);
  });

  it('locks the switch while enabling and then shows the running state', async () => {
    const user = userEvent.setup();
    releaseEnable = () => undefined;
    render(<PluginsTab />);
    const toggle = await screen.findByLabelText(t('plugins.toggleLabel', { name: 'stamp' }));
    await user.click(toggle);
    expect((toggle as HTMLInputElement).disabled).toBe(true);
    expect(screen.getAllByText(t('plugins.statusChanging')).length).toBeGreaterThan(0);
    const resolve = releaseEnable;
    expect(resolve).toBeTypeOf('function');
    resolve?.();
    await waitFor(() => expect(screen.getAllByText(t('plugins.statusRunning')).length).toBeGreaterThan(0));
  });

  it('keeps a failed enable switch off and shows the plugin-specific error', async () => {
    plugins[1] = { ...plugins[1], error: null };
    const user = userEvent.setup();
    render(<PluginsTab />);
    const toggle = await screen.findByLabelText(t('plugins.toggleLabel', { name: 'broken' }));
    await user.click(toggle);
    await waitFor(() => expect(screen.getByText('RuntimeError: boom')).toBeTruthy());
    expect((toggle as HTMLInputElement).checked).toBe(false);
  });

  it('can disable a running plugin', async () => {
    plugins = [{ ...base, enabled: true, loaded: true }];
    const user = userEvent.setup();
    render(<PluginsTab />);
    await user.click(await screen.findByLabelText(t('plugins.toggleLabel', { name: 'stamp' })));
    await waitFor(() => expect(calls.some((call) => call.endsWith('/stamp/disable'))).toBe(true));
    expect(screen.getAllByText(t('plugins.statusOff')).length).toBeGreaterThan(0);
  });

  it('moves a plugin and enables source watching from the overview', async () => {
    const user = userEvent.setup();
    render(<PluginsTab />);
    await user.click(await screen.findByText(`↓ ${t('plugins.moveDown')}`));
    await waitFor(() => expect(plugins.map((plugin) => plugin.name)).toEqual(['broken', 'stamp']));
    await user.click(screen.getByText(t('plugins.autoReload')).closest('label')!.querySelector('input')!);
    await waitFor(() => expect(calls.some((call) => call.includes('/auto-reload?enabled=true'))).toBe(true));
  });

  it('loads and edits SDK settings in the detail panel', async () => {
    plugins = [{ ...base, enabled: true, loaded: true, contributions: { settings: 1 } }];
    const user = userEvent.setup();
    render(<PluginsTab />);
    const sections = await screen.findByLabelText(t('plugins.detailSections'));
    await user.click(within(sections).getByRole('button', { name: t('plugins.detail.settings') }));
    const panel = await screen.findByLabelText(t('plugins.settingsFor', { name: 'stamp' }));
    const checkbox = within(panel).getByRole('checkbox');
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    await user.click(checkbox);
    await user.click(within(panel).getByText(t('plugins.saveSettings')));
    await waitFor(() => expect(calls.filter((call) => call.endsWith('/api/plugins/stamp/settings')).length).toBe(2));
  });

  it('shows and resets performance diagnostics without mixing in logs', async () => {
    const user = userEvent.setup();
    render(<PluginsTab />);
    const sections = await screen.findByLabelText(t('plugins.detailSections'));
    await user.click(within(sections).getByRole('button', { name: t('plugins.detail.performance') }));
    expect(await screen.findByText('stamp.inspect')).toBeTruthy();
    expect(screen.queryByText('ready')).toBeNull();
    await user.click(screen.getByText(t('plugins.resetDiagnostics')));
    await waitFor(() => expect(calls.some((call) => call.endsWith('/api/plugins/stamp/diagnostics/reset'))).toBe(true));
  });

  it('renders onboarding and installs the bundled sample without enabling it', async () => {
    plugins = [];
    const user = userEvent.setup();
    render(<PluginsTab />);
    expect(await screen.findByText(t('plugins.emptyTitle'))).toBeTruthy();
    expect(screen.getByText('Request Marker')).toBeTruthy();
    expect(screen.getByText('/home/u/.lanius/plugins')).toBeTruthy();
    await user.click(screen.getByText(t('plugins.installSample')));
    await waitFor(() => expect(calls.some((call) => call.endsWith('/api/plugin-samples/lanius.request-marker/install'))).toBe(true));
    const toggle = await screen.findByLabelText(t('plugins.toggleLabel', { name: 'lanius.request-marker' }));
    expect((toggle as HTMLInputElement).checked).toBe(false);
  });

  it('explains suspension and blocks enabling while still allowing installed plugins to be inspected', async () => {
    suspended = true;
    plugins = [{ ...base, enabled: false, loaded: false }];
    render(<PluginsTab />);
    expect(await screen.findByText('Lockdown Mode blocks plugin execution')).toBeTruthy();
    expect((screen.getByLabelText(t('plugins.toggleLabel', { name: 'stamp' })) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText('/p/stamp.py')).toBeTruthy();
  });

  it('opens the catalogue surface and installs a signed release', async () => {
    catalogue = {
      sources: [{ id: 'official', title: 'Official', url: 'https://example.test/catalog.json', public_key: 'key', key_id: 'release', enabled: true }],
      items: [{
        id: 'acme.scanner', name: 'Acme scanner', description: 'Checks headers', details: 'Explains which headers are missing.', icon: 'data:image/png;base64,iVBORw0KGgo=', homepage: 'https://example.test/scanner', author: 'Acme', categories: ['scanner'], source: 'official', source_title: 'Official',
        releases: [{ version: '1.0.0', url: 'https://example.test/acme.lanius-plugin', sha256: 'a'.repeat(64), package_key_id: 'release', compatibility: { lanius: '>=0.1,<1', sdk: '>=1,<2' }, compatible: true, revoked: false, revocation_reason: null }],
        latest_version: '1.0.0', installed_version: null, update_available: false, rollback_versions: [],
      }],
      errors: {},
      refreshed: false,
    };
    catalogue.items.push({ ...catalogue.items[0], id: 'acme.no-icon', name: 'No icon', icon: undefined });
    const user = userEvent.setup();
    render(<PluginsTab />);
    await user.click((await screen.findAllByText(t('plugins.catalogue')))[0]);
    expect(await screen.findByText('Acme scanner')).toBeTruthy();
    const card = screen.getByText('Acme scanner').closest('article')!;
    expect(screen.getByText('No icon').closest('article')!.querySelector('.plugin-catalogue-icon svg')).toBeTruthy();
    const icon = card.querySelector('.plugin-catalogue-icon img')!;
    expect(icon.getAttribute('src')).toBe(catalogue.items[0].icon);
    await user.click(within(card).getByText(t('plugins.more')));
    expect(within(card).getByText('Explains which headers are missing.')).toBeTruthy();
    expect(within(card).getByRole('link', { name: t('plugins.homepage') }).getAttribute('href')).toBe('https://example.test/scanner');
    expect(within(card).getByText('v1.0.0')).toBeTruthy();
    fireEvent.error(icon);
    expect(card.querySelector('.plugin-catalogue-icon svg')).toBeTruthy();
    await user.click(within(card).getByText(t('plugins.installFromCatalogue')));
    await waitFor(() => expect(calls.some((call) => call.endsWith('/api/plugin-catalogue/install'))).toBe(true));
  });

  it('presents an unloaded catalogue as an intentional first step', async () => {
    catalogue = {
      sources: [{ id: 'official', title: 'Official', url: 'https://example.test/catalog.json', public_key: 'key', key_id: 'release', enabled: true }],
      items: [],
      errors: { official: 'catalogue has not been refreshed: official' },
      refreshed: false,
    };
    const user = userEvent.setup();
    render(<PluginsTab />);
    await user.click((await screen.findAllByText(t('plugins.catalogue')))[0]);
    expect(await screen.findByText(t('plugins.catalogueFirstTitle'))).toBeTruthy();
    expect(screen.getByText(t('plugins.catalogueFirstHelp'))).toBeTruthy();
    expect(screen.queryByText(/catalogue has not been refreshed: official/)).toBeNull();
    expect(screen.queryByLabelText(t('plugins.catalogueSearch'))).toBeNull();
    expect(calls.some((call) => call.includes('/api/plugin-catalogue?refresh=true'))).toBe(false);

    await user.click(screen.getByRole('button', { name: t('plugins.catalogueRefresh') }));
    await waitFor(() => expect(calls.some((call) => call.includes('/api/plugin-catalogue?refresh=true'))).toBe(true));
  });

  it('opens source management from the empty catalogue', async () => {
    const user = userEvent.setup();
    render(<PluginsTab />);
    await user.click((await screen.findAllByText(t('plugins.catalogue')))[0]);
    expect(await screen.findByText(t('plugins.catalogueNoSourcesTitle'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('plugins.catalogueRefresh') })).toBeNull();
    await user.click(screen.getByRole('button', { name: t('plugins.catalogueManageSources') }));
    expect((document.querySelector('.plugin-catalogue-sources') as HTMLDetailsElement).open).toBe(true);
  });

  it('lists a packaged plugin view and opens it only when loaded', async () => {
    plugins = [{ ...installedSample(), enabled: true, loaded: true }];
    const user = userEvent.setup();
    render(<PluginsTab />);
    const sections = await screen.findByLabelText(t('plugins.detailSections'));
    await user.click(within(sections).getByRole('button', { name: new RegExp(t('plugins.detail.views')) }));
    await user.click(screen.getByText(t('plugins.openView')));
    expect(await screen.findByTitle('lanius.request-marker: Request Marker')).toBeTruthy();
  });
});

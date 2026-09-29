/** Plugins tab rendered against a mocked engine. */
import {cleanup, screen, waitFor, within } from '@testing-library/react';
import { renderWithI18n as render, t } from '../test-utils';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PluginsTab } from './PluginsTab';
import type { PluginInfo } from '../api/types';

let plugins: PluginInfo[] = [];
let calls: string[] = [];

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
};

function jsonResponse(body: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 400,
    statusText: ok ? 'OK' : 'Bad Request',
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  calls = [];
  plugins = [
    { ...base },
    {
      ...base,
      name: 'broken',
      description: null,
      version: '2.0.0',
      hooks: [],
      error: 'RuntimeError: boom',
    },
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/api/plugins')) {
        return jsonResponse({ items: plugins, directory: '/home/u/.lanius/plugins', safe_mode: false });
      }
      if (url.endsWith('/api/plugins/order')) {
        const names = JSON.parse(String(init?.body)) as string[];
        plugins = names.map((name, order) => ({
          ...plugins.find((plugin) => plugin.name === name)!,
          order,
        }));
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
      if (url.includes('/auto-reload')) {
        const name = url.split('/api/plugins/')[1].split('/')[0];
        const enabled = url.endsWith('enabled=true');
        plugins = plugins.map((plugin) =>
          plugin.name === name ? { ...plugin, auto_reload: enabled } : plugin,
        );
        return jsonResponse(plugins.find((plugin) => plugin.name === name));
      }
      if (url.includes('/broken/enable')) {
        return jsonResponse({ detail: 'RuntimeError: boom' }, false);
      }
      if (url.includes('/enable')) {
        plugins = plugins.map((p) =>
          p.name === 'stamp' ? { ...p, enabled: true, loaded: true } : p,
        );
        return jsonResponse(plugins[0]);
      }
      if (url.includes('/disable')) {
        plugins = plugins.map((p) =>
          p.name === 'stamp' ? { ...p, enabled: false, loaded: false } : p,
        );
        return jsonResponse(plugins[0]);
      }
      return jsonResponse({});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PluginsTab', () => {
  it('lists discovered plugins with metadata', async () => {
    render(<PluginsTab />);
    expect(await screen.findByText('/home/u/.lanius/plugins')).toBeTruthy();
    expect(screen.getByText('adds a header')).toBeTruthy();
    expect(screen.getByText('v1.0.0')).toBeTruthy();
    expect(screen.getByText('request')).toBeTruthy();
  });

  it('enables a plugin and reflects the loaded state', async () => {
    const user = userEvent.setup();
    render(<PluginsTab />);
    await user.click(await screen.findByLabelText(t('plugins.toggleLabel', { name: 'stamp' })));
    await waitFor(() => expect(screen.getByText(t('plugins.loaded'))).toBeTruthy());
    expect(calls.some((c) => c.endsWith('/api/plugins/stamp/enable'))).toBe(
      true,
    );
  });

  it('disables an enabled plugin', async () => {
    plugins = [{ ...base, enabled: true, loaded: true }];
    const user = userEvent.setup();
    render(<PluginsTab />);
    await user.click(await screen.findByLabelText(t('plugins.toggleLabel', { name: 'stamp' })));
    await waitFor(() =>
      expect(calls.some((c) => c.endsWith('/disable'))).toBe(true),
    );
  });

  it('shows load errors from the engine', async () => {
    render(<PluginsTab />);
    expect(await screen.findByText('RuntimeError: boom')).toBeTruthy();
    expect(screen.getByText(t('common.error'))).toBeTruthy();
  });

  it('keeps the failure message visible after the list refreshes', async () => {
    const user = userEvent.setup();
    render(<PluginsTab />);
    await user.click(await screen.findByLabelText(t('plugins.toggleLabel', { name: 'broken' })));
    // The engine says why the plugin failed; that is what a user needs.
    expect(await screen.findByText(/broken: RuntimeError: boom/)).toBeTruthy();
  });

  it('reloads a plugin', async () => {
    const user = userEvent.setup();
    render(<PluginsTab />);
    await user.click(await screen.findByLabelText(t('plugins.reloadLabel', { name: 'stamp' })));
    await waitFor(() =>
      expect(calls.some((c) => c.endsWith('/stamp/reload'))).toBe(true),
    );
  });

  it('changes plugin order', async () => {
    const user = userEvent.setup();
    plugins = plugins.map((plugin, order) => ({ ...plugin, order }));
    render(<PluginsTab />);
    await user.click(await screen.findByLabelText(t('plugins.moveDownLabel', { name: 'stamp' })));
    await waitFor(() => expect(calls.some((call) => call.endsWith('/api/plugins/order'))).toBe(true));
    expect(plugins.map((plugin) => plugin.name)).toEqual(['broken', 'stamp']);
  });

  it('enables automatic reload for a plugin', async () => {
    const user = userEvent.setup();
    render(<PluginsTab />);
    await user.click(await screen.findByLabelText(t('plugins.autoReloadLabel', { name: 'stamp' })));
    await waitFor(() => expect(calls.some((call) => call.includes('/auto-reload?enabled=true'))).toBe(true));
    expect(plugins[0].auto_reload).toBe(true);
  });

  it('edits settings contributed through the SDK', async () => {
    const user = userEvent.setup();
    plugins = [{
      ...base,
      enabled: true,
      loaded: true,
      sdk_api_version: '1.0',
      contributions: { settings: 1, actions: 1 },
    }];
    render(<PluginsTab />);
    await user.click(await screen.findByLabelText(t('plugins.settingsLabel', { name: 'stamp' })));
    const panel = await screen.findByLabelText(t('plugins.settingsFor', { name: 'stamp' }));
    const checkbox = within(panel).getByRole('checkbox');
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    await user.click(checkbox);
    await user.click(within(panel).getByText(t('plugins.saveSettings')));
    await waitFor(() => expect(calls.filter((call) => call.endsWith('/api/plugins/stamp/settings')).length).toBe(2));
  });

  it('explains an empty plugin directory', async () => {
    plugins = [];
    render(<PluginsTab />);
    expect(await screen.findByText(t('plugins.none'))).toBeTruthy();
  });
});

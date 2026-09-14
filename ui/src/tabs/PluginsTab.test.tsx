/** Plugins tab rendered against a mocked engine. */
import {cleanup, screen, waitFor } from '@testing-library/react';
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
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/api/plugins')) {
        return jsonResponse({ items: plugins, directory: '/home/u/.lanius/plugins' });
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

  it('explains an empty plugin directory', async () => {
    plugins = [];
    render(<PluginsTab />);
    expect(await screen.findByText(t('plugins.none'))).toBeTruthy();
  });
});

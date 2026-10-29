import { Activity } from 'react';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PluginInfo, PluginUiView } from '../api/types';
import { renderWithI18n as render, t } from '../test-utils';
import { PluginFrame } from './PluginFrame';

const view: PluginUiView = {
  id: 'main',
  title: 'Main view',
  entrypoint: 'ui/index.html',
};

const plugin: PluginInfo = {
  name: 'acme.demo',
  path: '/plugins/acme.demo/backend/__init__.py',
  enabled: true,
  loaded: true,
  error: null,
  description: 'demo',
  version: '1.0.0',
  author: 'Acme',
  hooks: [],
  order: 0,
  auto_reload: false,
  sdk_api_version: '1.0',
  contributions: { actions: 1 },
  package: {
    schema: 1,
    id: 'acme.demo',
    name: 'Demo',
    permissions: ['actions.invoke'],
    signature_present: false,
    trust: 'unsigned',
    development: false,
    source: 'archive',
    catalog_source: null,
  },
  ui: { views: [view] },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PluginFrame', () => {
  it('uses an opaque sandbox and invokes only the plugin action namespace', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => ({
      ok: true,
      json: async () => ({ result: { ok: true } }),
    } as Response));
    vi.stubGlobal('fetch', fetchMock);
    render(<PluginFrame plugin={plugin} view={view} onClose={() => undefined} />);
    const iframe = screen.getByTitle('acme.demo: Main view') as HTMLIFrameElement;
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin');
    const target = iframe.contentWindow!;
    const reply = vi.spyOn(target, 'postMessage');

    window.dispatchEvent(new MessageEvent('message', {
      source: target,
      data: {
        type: 'lanius.request',
        plugin: 'acme.demo',
        id: 'request-1',
        method: 'actions.invoke',
        params: { action: 'acme.demo.hello', context: { location: 'global' } },
      },
    }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      '/api/plugin-actions/acme.demo.hello/invoke',
    );
    await waitFor(() => expect(reply).toHaveBeenCalledWith(
      { type: 'lanius.response', id: 'request-1', result: { ok: true } },
      '*',
    ));
  });

  it('rejects undeclared bridge permissions before calling the engine', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(
      <PluginFrame
        plugin={{ ...plugin, package: { ...plugin.package!, permissions: [] } }}
        view={view}
        onClose={() => undefined}
      />,
    );
    const iframe = screen.getByTitle('acme.demo: Main view') as HTMLIFrameElement;
    const target = iframe.contentWindow!;
    const reply = vi.spyOn(target, 'postMessage');

    window.dispatchEvent(new MessageEvent('message', {
      source: target,
      data: {
        type: 'lanius.request',
        plugin: 'acme.demo',
        id: 'request-2',
        method: 'actions.invoke',
        params: { action: 'acme.demo.hello' },
      },
    }));

    await waitFor(() => expect(reply).toHaveBeenCalled());
    expect(reply.mock.calls[0][0]).toEqual({
      type: 'lanius.response',
      id: 'request-2',
      error: 'permission denied: actions.invoke',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

it('rejects clipboard writes without the declared permission', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  render(<PluginFrame plugin={plugin} view={view} />);
  const target = (screen.getByTitle('acme.demo: Main view') as HTMLIFrameElement).contentWindow!;
  const reply = vi.spyOn(target, 'postMessage');
  window.dispatchEvent(new MessageEvent('message', { source: target, data: {
    type: 'lanius.request', plugin: plugin.name, id: 'copy', method: 'clipboard.write', params: { text: 'flow-id' },
  } }));
  await waitFor(() => expect(reply).toHaveBeenCalledWith({
    type: 'lanius.response', id: 'copy', error: 'permission denied: clipboard.write',
  }, '*'));
  expect(fetchMock).not.toHaveBeenCalled();
});

it('confirms successful plugin clipboard writes with the shared toast', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  render(<PluginFrame
    plugin={{
      ...plugin,
      package: { ...plugin.package!, permissions: ['actions.invoke', 'clipboard.write'] },
    }}
    view={view}
  />);
  const target = (screen.getByTitle('acme.demo: Main view') as HTMLIFrameElement).contentWindow!;
  const reply = vi.spyOn(target, 'postMessage');
  window.dispatchEvent(new MessageEvent('message', { source: target, data: {
    type: 'lanius.request', plugin: plugin.name, id: 'copy', method: 'clipboard.write', params: { text: 'flow-id' },
  } }));

  await waitFor(() => expect(writeText).toHaveBeenCalledWith('flow-id'));
  await waitFor(() => expect(reply).toHaveBeenCalledWith({
    type: 'lanius.response', id: 'copy', result: { copied: true },
  }, '*'));
  expect(screen.getByRole('status').textContent).toBe(t('menu.copied'));
});

it('shares host controls and synchronizes resolved palette and typography without reloading the frame', async () => {
  const root = document.documentElement;
  const previousStyle = root.getAttribute('style');
  const previousTheme = root.getAttribute('data-theme');
  root.dataset.theme = 'steel';
  root.style.setProperty('--bg', '#1f1f1f');
  root.style.setProperty('--font-size-ui', '15px');
  root.style.setProperty('--private-host-value', 'not-a-theme-token');
  root.style.colorScheme = 'dark';
  try {
    render(<PluginFrame plugin={plugin} view={view} />);
    const iframe = screen.getByTitle('acme.demo: Main view') as HTMLIFrameElement;
    const target = iframe.contentWindow!;
    const reply = vi.spyOn(target, 'postMessage');
    const source = iframe.src;
    window.dispatchEvent(new MessageEvent('message', { source: target, data: {
      type: 'lanius.request', plugin: plugin.name, id: 'theme', method: 'theme.get',
    } }));
    await waitFor(() => expect(reply).toHaveBeenCalled());
    const theme = reply.mock.calls[0][0].result;
    expect(theme.version).toBe(1);
    expect(theme.theme).toBe('steel');
    expect(theme.colorScheme).toBe('dark');
    expect(theme.variables['--bg']).toBe('#1f1f1f');
    expect(theme.variables['--font-size-ui']).toBe('15px');
    expect(theme.variables).not.toHaveProperty('--private-host-value');
    expect(theme.css).toContain('button');
    expect(theme.css).toContain('var(--font-ui)');
    expect(theme.css).toContain('var(--border)');

    root.dataset.theme = 'light';
    root.style.colorScheme = 'light';
    root.style.setProperty('--bg', '#f6f7f9');
    root.style.setProperty('--font-size-ui', '18px');
    await waitFor(() => expect(reply).toHaveBeenCalledWith({
      type: 'lanius.theme.changed', theme: expect.objectContaining({
        theme: 'light', colorScheme: 'light', variables: expect.objectContaining({
          '--bg': '#f6f7f9', '--font-size-ui': '18px',
        }),
      }),
    }, '*'));
    expect(iframe.src).toBe(source);
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin');
    cleanup();
    const calls = reply.mock.calls.length;
    root.style.setProperty('--font-size-ui', '12px');
    await Promise.resolve();
    expect(reply.mock.calls.length).toBe(calls);
  } finally {
    if (previousStyle === null) root.removeAttribute('style'); else root.setAttribute('style', previousStyle);
    if (previousTheme === null) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', previousTheme);
  }
});

it('catches up a retained hidden frame when it becomes visible again', async () => {
  const root = document.documentElement;
  const previous = root.getAttribute('style');
  const previousTheme = root.getAttribute('data-theme');
  try {
    root.dataset.theme = 'dark';
    const rendered = render(<Activity mode="visible"><PluginFrame plugin={plugin} view={view} /></Activity>);
    const iframe = screen.getByTitle('acme.demo: Main view') as HTMLIFrameElement;
    const target = iframe.contentWindow!;
    const reply = vi.spyOn(target, 'postMessage');
    window.dispatchEvent(new MessageEvent('message', { source: target, data: {
      type: 'lanius.request', plugin: plugin.name, id: 'theme', method: 'theme.get',
    } }));
    await waitFor(() => expect(reply).toHaveBeenCalled());
    rendered.rerender(<Activity mode="hidden"><PluginFrame plugin={plugin} view={view} /></Activity>);
    reply.mockClear();
    root.dataset.theme = 'light';
    root.style.setProperty('--font-size-ui', '17px');
    rendered.rerender(<Activity mode="visible"><PluginFrame plugin={plugin} view={view} /></Activity>);
    await waitFor(() => expect(reply).toHaveBeenCalledWith({
      type: 'lanius.theme.changed', theme: expect.objectContaining({
        theme: 'light', variables: expect.objectContaining({ '--font-size-ui': '17px' }),
      }),
    }, '*'));
    expect(screen.getByTitle('acme.demo: Main view')).toBe(iframe);
  } finally {
    cleanup();
    if (previous === null) root.removeAttribute('style'); else root.setAttribute('style', previous);
    if (previousTheme === null) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', previousTheme);
  }
});

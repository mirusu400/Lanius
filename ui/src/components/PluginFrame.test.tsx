import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PluginInfo, PluginUiView } from '../api/types';
import { renderWithI18n as render } from '../test-utils';
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

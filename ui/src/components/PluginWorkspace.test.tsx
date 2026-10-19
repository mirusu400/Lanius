import { act, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithI18n as render } from '../test-utils';
import type { PluginInfo } from '../api/types';
import { PluginWorkspaceProvider } from './PluginWorkspace';
import { openPluginActionView, usePluginWorkspace } from './pluginViewBridge';

const plugin = {
  name: 'demo', loaded: true, package: { permissions: ['actions.invoke', 'ui.downloads'] },
  ui: { views: [{ id: 'flow', title: 'Flow', entrypoint: 'ui/index.html', placement: 'tab' }] },
} as PluginInfo;
function Harness() {
  const workspace = usePluginWorkspace();
  return <>{workspace.tabs.map(({ key, view }) => <button key={key} onClick={() => workspace.select(key)}>{view.title}</button>)}{workspace.content}</>;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('Plugin workspace', () => {
  it('mounts installed tab views and keeps their sandbox and download permission', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ items: [plugin], suspended: false }) })));
    render(<PluginWorkspaceProvider><Harness /></PluginWorkspaceProvider>);
    await userEvent.click(await screen.findByRole('button', { name: 'Flow' }));
    const frame = screen.getByTitle('demo: Flow');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-downloads');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
  });
  it('opens only an owner-declared view and passes selection through the context bridge', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ items: [plugin], suspended: false }) })));
    render(<PluginWorkspaceProvider><Harness /></PluginWorkspaceProvider>);
    await screen.findByRole('button', { name: 'Flow' });
    act(() => openPluginActionView('other', { ui: { mode: 'dialog', view: 'flow' } }));
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => openPluginActionView('demo', { ui: { mode: 'dialog', view: 'flow', context: { exchange_ids: ['e1'] } } }));
    const frame = screen.getByTitle('demo: Flow') as HTMLIFrameElement;
    expect(screen.getByRole('dialog')).toBeTruthy();
    const reply = vi.spyOn(frame.contentWindow!, 'postMessage');
    window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: {
      type: 'lanius.request', plugin: 'demo', id: 'context', method: 'context.get',
    } }));
    await waitFor(() => expect(reply).toHaveBeenCalledWith({
      type: 'lanius.response', id: 'context', result: { exchange_ids: ['e1'] },
    }, '*'));
    await userEvent.click(screen.getByRole('dialog').querySelector('button')!);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('hides views while execution is suspended', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ items: [plugin], suspended: true }) })));
    render(<PluginWorkspaceProvider><Harness /></PluginWorkspaceProvider>);
    await act(async () => {});
    expect(screen.queryByRole('button', { name: 'Flow' })).toBeNull();
  });
});

it('removes disabled views immediately and does not reopen a stale dialog on re-enable', async () => {
  const sockets: { onmessage?: (event: { data: string }) => void }[] = [];
  vi.stubGlobal('WebSocket', class {
    onmessage?: (event: { data: string }) => void;
    constructor() { sockets.push(this); }
    close() {}
  });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ items: [plugin], suspended: false }) })));
  render(<PluginWorkspaceProvider><Harness /></PluginWorkspaceProvider>);
  await screen.findByRole('button', { name: 'Flow' });
  act(() => openPluginActionView('demo', { ui: { mode: 'dialog', view: 'flow' } }));
  expect(screen.getByRole('dialog')).toBeTruthy();
  act(() => sockets[0].onmessage?.({ data: JSON.stringify({ type: 'plugins.changed', data: [] }) }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Flow' })).toBeNull();
  act(() => sockets[0].onmessage?.({ data: JSON.stringify({ type: 'plugins.changed', data: [plugin] }) }));
  expect(screen.getByRole('button', { name: 'Flow' })).toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();
});

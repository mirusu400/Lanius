/** The MCP controls in Settings.
 *
 * MCP existed in the engine but nowhere in the interface, so nobody could
 * tell it was there, what it let an agent do, or how to switch it off.
 */
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { McpSection } from './settings/McpSection';
import { setApiBase } from '../api/client';
import { connectStream } from '../api/stream';
import type { McpState } from '../api/types';
import { renderWithI18n as render, t } from '../test-utils';

vi.mock('../api/stream', () => ({ connectStream: vi.fn(() => () => {}) }));

const TOOLS = [
  { name: 'list_flows', description: 'List captured flows, newest first.', writes: false },
  { name: 'get_flow', description: 'Fetch one captured flow.', writes: false },
  { name: 'send_request', description: 'Send a request through the proxy.', writes: true },
  { name: 'add_scope_rule', description: 'Add a scope rule.', writes: true },
];

let mcp: McpState = {
  available: true,
  enabled: true,
  url: 'http://127.0.0.1:12954/mcp/mcp',
  host: '127.0.0.1',
  port: 12954,
  tools: TOOLS,
};
let posted: boolean[] = [];
let copied: string[] = [];

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers({ 'Content-Type': 'application/json' }),
  } as unknown as Response;
}

beforeEach(() => {
  mcp = {
    available: true,
    enabled: true,
    url: 'http://127.0.0.1:12954/mcp/mcp',
    host: '127.0.0.1',
    port: 12954,
    tools: TOOLS,
  };
  posted = [];
  copied = [];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/mcp')) {
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as { enabled: boolean };
          posted.push(body.enabled);
          mcp = { ...mcp, enabled: body.enabled };
        }
        return jsonResponse(mcp);
      }
      if (url.includes('/api/listener')) {
        return jsonResponse({
          host: '127.0.0.1',
          port: 8080,
          running: true,
          error: null,
          exposed: false,
          addresses: [{ host: '127.0.0.1', label: 'This machine only' }],
        });
      }
      if (url.includes('/api/ca')) return jsonResponse({ available: false });
      if (url.includes('/api/tls')) {
        return jsonResponse({
          profile: 'default',
          custom_ciphers: null,
          ciphers: null,
          available: [{ id: 'default', label: 'mitmproxy default' }],
        });
      }
      if (url.includes('/api/capture/local')) {
        return jsonResponse({ supported: false, approved: false, detail: '' });
      }
      if (url.includes('/api/status')) {
        return jsonResponse({
          version: '0.1.0',
          proxy: { running: true, host: '127.0.0.1', port: 8080, error: null },
          flows: 0,
          subscribers: 0,
          db_path: '/tmp/x.sqlite',
          intercept: {
            enabled: false,
            intercept_requests: true,
            intercept_responses: false,
            host_filter: null,
          },
          paused: 0,
          modes: [],
          local_capture: { supported: false, approved: false, detail: '', spec: null },
        });
      }
      return jsonResponse({});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  setApiBase('http://127.0.0.1:12954');
});

const mcpSection = () => {
  const heading = screen.getByText(t('mcp.section'));
  const section = heading.closest('section');
  if (!section) throw new Error('MCP section not found');
  return within(section);
};

describe('MCP settings', () => {
  it('shows an initial load failure and clears it after reconnecting', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('engine offline'));
    render(<McpSection />);

    expect(await screen.findByText('engine offline')).toBeTruthy();
    expect(mcpSection().getByText(t('mcp.help'))).toBeTruthy();

    const handlers = vi.mocked(connectStream).mock.calls.at(-1)![0];
    handlers.onState?.('open');
    expect(await screen.findByText('list_flows')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('engine offline')).toBeNull());
  });

  it('does not let a delayed catalogue refresh undo the displayed MCP off switch', async () => {
    const user = userEvent.setup();
    render(<McpSection />);
    await screen.findByText(t('mcp.section'));
    const before = { ...mcp };
    let resolveRefresh!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    }));
    const handlers = vi.mocked(connectStream).mock.calls.at(-1)![0];
    handlers.onEvent({ type: 'mcp.tools_changed', data: {} });
    await user.click(mcpSection().getByLabelText(t('mcp.enable')));
    expect(await screen.findByText(t('mcp.disabled'))).toBeTruthy();
    await act(async () => { resolveRefresh(jsonResponse(before)); });
    expect(mcpSection().getByText(t('mcp.disabled'))).toBeTruthy();
    expect((mcpSection().getByLabelText(t('mcp.enable')) as HTMLInputElement).checked).toBe(false);
  });

  it('refreshes plugin tools and ownership when the live catalogue changes', async () => {
    render(<McpSection />);
    await waitFor(() => expect(screen.getByText('list_flows')).toBeTruthy());
    const handlers = vi.mocked(connectStream).mock.calls.at(-1)![0];
    mcp = { ...mcp, tools: [...TOOLS, {
      name: 'notes.read_note', description: 'Read a project note', writes: false, plugin: 'notes',
    }] };
    handlers.onEvent({ type: 'mcp.tools_changed', data: {} });
    expect(await screen.findByText('notes.read_note')).toBeTruthy();
    const row = screen.getByText('notes.read_note').closest('li')!;
    const owner = within(row).getByText('notes');
    const access = within(row).getByText(t('mcp.readOnly'));
    expect(owner.parentElement).toBe(access.parentElement);
    expect(row.children).toHaveLength(3);
    mcp = { ...mcp, tools: TOOLS };
    handlers.onEvent({ type: 'mcp.tools_changed', data: {} });
    await waitFor(() => expect(screen.queryByText('notes.read_note')).toBeNull());
  });

  it('groups and filters tools while truncating long plugin ownership visually', async () => {
    const user = userEvent.setup();
    const owner = `plugin-${'long-'.repeat(24)}owner`;
    mcp = { ...mcp, tools: [...TOOLS, {
      name: `${owner}.inspect`,
      description: 'Inspect private plugin state',
      writes: false,
      plugin: owner,
    }] };
    render(<McpSection />);

    const builtInGroup = (await screen.findByText(t('mcp.builtInTools'))).closest('details')!;
    const pluginGroup = screen.getByText(t('mcp.pluginTools', { plugin: owner })).closest('details')!;
    expect(builtInGroup.open).toBe(true);
    expect(pluginGroup.open).toBe(false);
    expect(pluginGroup.querySelector('.mcp-tool-owner')?.getAttribute('title')).toBe(owner);

    await user.type(screen.getByRole('searchbox', { name: t('mcp.toolsSearch') }), 'private');
    expect(screen.getByText(`${owner}.inspect`)).toBeTruthy();
    expect(screen.queryByText('list_flows')).toBeNull();
    expect(pluginGroup.open).toBe(true);

    await user.clear(screen.getByRole('searchbox', { name: t('mcp.toolsSearch') }));
    await user.type(screen.getByRole('searchbox', { name: t('mcp.toolsSearch') }), 'missing tool');
    expect(screen.getByText(t('mcp.noToolMatches'))).toBeTruthy();
  });

  it('shows where an agent connects', async () => {
    render(<McpSection />);
    await waitFor(() => expect(screen.getByText(t('mcp.section'))).toBeTruthy());
    expect(mcpSection().getByText('http://127.0.0.1:12954/mcp/mcp')).toBeTruthy();
    expect(mcpSection().getByText(t('mcp.localOnly'))).toBeTruthy();
  });

  it('lists the tools, and marks the ones that act', async () => {
    render(<McpSection />);
    await waitFor(() => expect(screen.getByText(t('mcp.section'))).toBeTruthy());

    expect(mcpSection().getByText('list_flows')).toBeTruthy();
    expect(mcpSection().getByText('send_request')).toBeTruthy();
    expect(
      mcpSection().getByText(t('mcp.toolsHeading', { count: TOOLS.length })),
    ).toBeTruthy();

    // A tool that sends traffic must not look like a lookup.
    const row = mcpSection().getByText('send_request').closest('li')!;
    expect(within(row).getByText(t('mcp.writes'))).toBeTruthy();
    const readRow = mcpSection().getByText('list_flows').closest('li')!;
    expect(within(readRow).getByText(t('mcp.readOnly'))).toBeTruthy();
  });

  it('warns that an agent can act, not just read', async () => {
    render(<McpSection />);
    await waitFor(() => expect(screen.getByText(t('mcp.section'))).toBeTruthy());
    expect(mcpSection().getByText(t('mcp.writesWarning'))).toBeTruthy();
  });

  it('turns agents off and on', async () => {
    const user = userEvent.setup();
    render(<McpSection />);
    await waitFor(() => expect(screen.getByText(t('mcp.section'))).toBeTruthy());

    await user.click(mcpSection().getByLabelText(t('mcp.enable')));
    await waitFor(() => expect(posted).toEqual([false]));
    expect(await screen.findByText(t('mcp.disabled'))).toBeTruthy();

    await user.click(mcpSection().getByLabelText(t('mcp.enable')));
    await waitFor(() => expect(posted).toEqual([false, true]));
    expect(await screen.findByText(t('mcp.enabled'))).toBeTruthy();
  });

  it('copies a client config carrying this engine port', async () => {
    const user = userEvent.setup();
    // After setup: userEvent installs its own clipboard, which would
    // otherwise replace this one.
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copied.push(text);
        },
      },
    });
    render(<McpSection />);
    await waitFor(() => expect(screen.getByText(t('mcp.section'))).toBeTruthy());

    await user.click(mcpSection().getByRole('button', { name: t('mcp.copy') }));
    await waitFor(() => expect(copied).toHaveLength(1));

    // Pasteable as-is, and pointing at the port actually in use.
    const config = JSON.parse(copied[0]) as {
      mcpServers: { lanius: { type: string; url: string } };
    };
    expect(config.mcpServers.lanius.type).toBe('http');
    expect(config.mcpServers.lanius.url).toBe('http://127.0.0.1:12954/mcp/mcp');
    expect((await screen.findByRole('status')).textContent).toBe(t('mcp.copied'));
  });

  it('shows and copies Codex and Claude Code commands for the active endpoint', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { copied.push(text); } },
    });
    render(<McpSection />);
    await waitFor(() => expect(screen.getByText(t('mcp.section'))).toBeTruthy());

    const codex = 'codex mcp add lanius --url http://127.0.0.1:12954/mcp/mcp';
    const claude = 'claude mcp add --transport http --scope user lanius http://127.0.0.1:12954/mcp/mcp';
    expect(mcpSection().getByText(codex)).toBeTruthy();
    expect(mcpSection().getByText(claude)).toBeTruthy();

    await user.click(mcpSection().getByRole('button', { name: t('mcp.copyCommand', { client: 'Codex' }) }));
    await user.click(mcpSection().getByRole('button', { name: t('mcp.copyCommand', { client: 'Claude Code' }) }));
    expect(copied).toEqual([codex, claude]);
    expect((await screen.findByRole('status')).textContent).toBe(t('mcp.commandCopied'));
  });

  it('says so when the MCP server did not start', async () => {
    mcp = { ...mcp, available: false, tools: [] };
    render(<McpSection />);
    expect(await screen.findByText(t('mcp.unavailable'))).toBeTruthy();
  });

  it('changes the shared MCP/API port and shows the new endpoint', async () => {
    const invoke = vi.fn(async (command: string, args?: { port: number }) => {
      if (command !== 'set_api_port') throw new Error(`unexpected command: ${command}`);
      mcp = {
        ...mcp,
        port: args!.port,
        url: `http://127.0.0.1:${args!.port}/mcp/mcp`,
      };
      return { api_url: `http://127.0.0.1:${args!.port}` };
    });
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: { invoke },
    });
    const user = userEvent.setup();
    render(<McpSection />);
    const field = await screen.findByLabelText(t('mcp.port'));
    await user.clear(field);
    await user.type(field, '13001');
    await user.click(screen.getByRole('button', { name: t('mcp.applyPort') }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_api_port', { port: 13001 }));
    expect(await screen.findByText('http://127.0.0.1:13001/mcp/mcp')).toBeTruthy();
    expect(screen.getByText('codex mcp add lanius --url http://127.0.0.1:13001/mcp/mcp')).toBeTruthy();
    expect(screen.getByText('claude mcp add --transport http --scope user lanius http://127.0.0.1:13001/mcp/mcp')).toBeTruthy();
    expect((field as HTMLInputElement).value).toBe('13001');
    expect(vi.mocked(fetch)).toHaveBeenCalledWith('http://127.0.0.1:13001/api/mcp', undefined);
  });
});

/** The MCP controls in Settings.
 *
 * MCP existed in the engine but nowhere in the interface, so nobody could
 * tell it was there, what it let an agent do, or how to switch it off.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsTab } from './SettingsTab';
import { renderWithI18n as render, t } from '../test-utils';

const TOOLS = [
  { name: 'list_flows', description: 'List captured flows, newest first.', writes: false },
  { name: 'get_flow', description: 'Fetch one captured flow.', writes: false },
  { name: 'send_request', description: 'Send a request through the proxy.', writes: true },
  { name: 'add_scope_rule', description: 'Add a scope rule.', writes: true },
];

let mcp = {
  available: true,
  enabled: true,
  url: 'http://127.0.0.1:8081/mcp',
  host: '127.0.0.1',
  port: 8081,
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
    url: 'http://127.0.0.1:8081/mcp',
    host: '127.0.0.1',
    port: 8081,
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
});

const mcpSection = () => {
  const heading = screen.getByText(t('mcp.section'));
  const section = heading.closest('section');
  if (!section) throw new Error('MCP section not found');
  return within(section);
};

describe('MCP settings', () => {
  it('shows where an agent connects', async () => {
    render(<SettingsTab />);
    await waitFor(() => expect(screen.getByText(t('mcp.section'))).toBeTruthy());
    expect(mcpSection().getByText('http://127.0.0.1:8081/mcp')).toBeTruthy();
    expect(mcpSection().getByText(t('mcp.localOnly'))).toBeTruthy();
  });

  it('lists the tools, and marks the ones that act', async () => {
    render(<SettingsTab />);
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
    render(<SettingsTab />);
    await waitFor(() => expect(screen.getByText(t('mcp.section'))).toBeTruthy());
    expect(mcpSection().getByText(t('mcp.writesWarning'))).toBeTruthy();
  });

  it('turns agents off and on', async () => {
    const user = userEvent.setup();
    render(<SettingsTab />);
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
    render(<SettingsTab />);
    await waitFor(() => expect(screen.getByText(t('mcp.section'))).toBeTruthy());

    await user.click(mcpSection().getByRole('button', { name: t('mcp.copy') }));
    await waitFor(() => expect(copied).toHaveLength(1));

    // Pasteable as-is, and pointing at the port actually in use.
    const config = JSON.parse(copied[0]) as {
      mcpServers: { lanius: { url: string } };
    };
    expect(config.mcpServers.lanius.url).toBe('http://127.0.0.1:8081/mcp');
    expect(await screen.findByText(t('mcp.copied'))).toBeTruthy();
  });

  it('says so when the MCP server did not start', async () => {
    mcp = { ...mcp, available: false, tools: [] };
    render(<SettingsTab />);
    expect(await screen.findByText(t('mcp.unavailable'))).toBeTruthy();
  });
});

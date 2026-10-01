/** Dashboard tab rendered against a mocked engine. */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import App from '../App';
import { DashboardTab } from './DashboardTab';
import { TAB_ORDER_STORAGE_KEY } from '../tabOrder';
import { renderWithI18n as render, t } from '../test-utils';
import type { Dashboard } from '../api/types';

const empty: Dashboard = {
  flows: 0,
  hosts: 0,
  bytes: 0,
  avg_duration_ms: null,
  errors: 0,
  pending: 0,
  first_seen: null,
  last_seen: null,
  span_seconds: 0,
  recent_flows: 0,
  recent_window_seconds: 300,
  status_groups: {},
  methods: [],
  top_hosts: [],
  proxy: { running: true, host: '127.0.0.1', port: 8080 },
  intercept_enabled: false,
  paused: 0,
  version: '0.1.0',
  modes: [{ spec: 'regular', running: true, listening: true, error: null }],
  local_capture: { supported: true, approved: true, detail: null },
};

const populated: Dashboard = {
  ...empty,
  flows: 42,
  hosts: 3,
  bytes: 1024 * 1024 * 5,
  avg_duration_ms: 125.5,
  pending: 2,
  span_seconds: 200,
  recent_flows: 7,
  status_groups: { '2xx': 30, '3xx': 2, '4xx': 6, '5xx': 4 },
  methods: [
    { method: 'GET', count: 35 },
    { method: 'POST', count: 7 },
  ],
  top_hosts: [
    {
      host: 'api.example.com',
      scheme: 'https',
      port: 443,
      flows: 28,
      errors: 5,
      bytes: 1024 * 900,
      last_seen: 1,
    },
    {
      host: 'cdn.example.com',
      scheme: 'https',
      port: 443,
      flows: 14,
      errors: 0,
      bytes: 1024 * 100,
      last_seen: 1,
    },
  ],
};

let payload: Dashboard = empty;
let scannerChecks = 0;

beforeEach(() => {
  payload = empty;
  scannerChecks = 0;
  window.localStorage.clear();
  // Route by path: the title-bar test renders the whole app, so other tabs
  // fetch too and must not be handed the dashboard's shape.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => {
        const path = String(url);
        if (path.includes('/api/dashboard')) return payload;
        if (path.includes('/api/intercept')) {
          return {
            rules: {
              enabled: false,
              intercept_requests: true,
              intercept_responses: false,
              host_filter: null,
            },
            paused: [],
          };
        }
        if (path.includes('/api/status')) return payload;
        if (path.includes('/api/scanner')) {
          return {
            passive_enabled: true,
            passive_checks: scannerChecks > 0
              ? [{ id: 'headers', plugin: 'scanner', title: 'Headers', description: null, mode: 'passive' }]
              : [],
            active_checks: [],
            jobs: [],
          };
        }
        return { items: [], count: 0 };
      },
    })) as unknown as typeof fetch,
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DashboardTab', () => {
  it('invites the user to send traffic when nothing is captured', async () => {
    render(<DashboardTab />);
    expect(await screen.findByText(t('dash.empty'))).toBeTruthy();
    // The address must be spelled out, otherwise the hint is not actionable.
    expect(screen.getByText(t('dash.emptyHelp', { address: '127.0.0.1:8080' }))).toBeTruthy();
  });

  it('summarises a capture', async () => {
    payload = populated;
    render(<DashboardTab />);

    expect(await screen.findByText('42')).toBeTruthy();
    expect(screen.getByText('5.0 MB')).toBeTruthy();
    expect(screen.getByText('126 ms')).toBeTruthy();
  });

  it('separates in-flight requests from completed ones', async () => {
    payload = populated;
    render(<DashboardTab />);
    expect(await screen.findByText(new RegExp(t('dash.pending')))).toBeTruthy();
  });

  it('breaks responses down by status group', async () => {
    payload = populated;
    render(<DashboardTab />);

    expect(await screen.findByText(t('dash.status2xx'))).toBeTruthy();
    expect(screen.getByText(t('dash.status5xx'))).toBeTruthy();
  });

  it('sizes each status bar by its share of responses', async () => {
    payload = populated;
    const { container } = render(<DashboardTab />);
    await screen.findByText(t('dash.status2xx'));

    // 30 of 42 responses are 2xx.
    const bar = container.querySelector('.dash-bar.s2xx') as HTMLElement;
    expect(bar.style.width).toBe(`${(30 / 42) * 100}%`);
  });

  it('ranks the busiest hosts and flags their failures', async () => {
    payload = populated;
    render(<DashboardTab />);

    expect(await screen.findByText('api.example.com')).toBeTruthy();
    expect(screen.getByText('cdn.example.com')).toBeTruthy();
    expect(screen.getByText(t('dash.errorsShort', { count: '5' }))).toBeTruthy();
  });

  it('reports proxy and intercept state', async () => {
    payload = { ...populated, intercept_enabled: true, paused: 3 };
    render(<DashboardTab />);

    expect(
      await screen.findByText(t('dash.proxyRunning', { address: '127.0.0.1:8080' })),
    ).toBeTruthy();
    expect(screen.getByText(t('dash.interceptOn'))).toBeTruthy();
    expect(screen.getByText(t('dash.pausedFlows', { count: '3' }))).toBeTruthy();
  });

  it('says so when the proxy is not running', async () => {
    payload = { ...populated, proxy: { ...populated.proxy, running: false } };
    render(<DashboardTab />);
    expect(await screen.findByText(t('dash.proxyStopped'))).toBeTruthy();
  });

  it('opens the Target tab when a host row is clicked', async () => {
    payload = populated;
    const onOpenTab = vi.fn();
    render(<DashboardTab onOpenTab={onOpenTab} />);

    await userEvent.click(await screen.findByText('api.example.com'));
    expect(onOpenTab).toHaveBeenCalledWith('Target');
  });

  it('survives an engine that is not up yet', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connection refused');
      }) as unknown as typeof fetch,
    );
    // Must not throw: the tab is the landing screen, so it renders before
    // the engine has finished starting.
    expect(() => render(<DashboardTab />)).not.toThrow();
  });
});

describe('warnings', () => {
  it('says nothing when every mode is healthy', async () => {
    payload = populated;
    render(<DashboardTab />);
    await screen.findByText(t('dash.title'));
    expect(screen.queryByText(t('dash.captureWaiting'))).toBeNull();
  });

  it('reports a mode that is not running, with its cause', async () => {
    payload = {
      ...populated,
      modes: [
        { spec: 'regular', running: true, listening: true, error: null },
        {
          spec: 'reverse:http://x@9',
          running: false,
          listening: false,
          error: 'address already in use',
        },
      ],
    };
    render(<DashboardTab />);

    expect(
      await screen.findByText(t('dash.modeDown', { spec: 'reverse:http://x@9' })),
    ).toBeTruthy();
    expect(screen.getByText(/address already in use/)).toBeTruthy();
  });

  it('tells the user to approve local capture when it is waiting', async () => {
    // The engine cannot see this through mitmproxy: the mode claims to be
    // running while the OS extension is unapproved.
    payload = {
      ...populated,
      modes: [
        { spec: 'local:curl', running: true, listening: false, error: null },
      ],
      local_capture: {
        supported: true,
        approved: false,
        detail: 'activated waiting for user',
      },
    };
    render(<DashboardTab />);

    expect(await screen.findByText(t('dash.captureWaiting'))).toBeTruthy();
    expect(screen.getByText(t('dash.captureWaitingHelp'))).toBeTruthy();
  });

  it('does not nag about approval when no local mode is configured', async () => {
    payload = {
      ...populated,
      local_capture: {
        supported: true,
        approved: false,
        detail: 'activated waiting for user',
      },
    };
    render(<DashboardTab />);
    await screen.findByText(t('dash.title'));
    expect(screen.queryByText(t('dash.captureWaiting'))).toBeNull();
  });

  it('distinguishes an uninstalled extension from one awaiting approval', async () => {
    payload = {
      ...populated,
      modes: [
        { spec: 'local:curl', running: true, listening: false, error: null },
      ],
      local_capture: {
        supported: true,
        approved: false,
        detail: 'not installed',
      },
    };
    render(<DashboardTab />);

    expect(
      await screen.findByText(
        t('dash.captureUnavailable', { detail: 'not installed' }),
      ),
    ).toBeTruthy();
  });
});

describe('title bar', () => {
  it('only shows Issues when a scanner plugin contributes checks', async () => {
    render(<App />);
    await waitFor(() => expect(
      vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/api/scanner')),
    ).toBe(true));
    expect(screen.queryByRole('button', { name: t('issues.title') })).toBeNull();

    cleanup();
    scannerChecks = 1;
    render(<App />);
    const issues = await screen.findByRole('button', { name: t('issues.title') });
    const tabs = within(issues.closest('nav')!).getAllByRole('button');
    expect(tabs.slice(0, 3).map((button) => button.textContent)).toEqual([
      t('dash.title'),
      t('issues.title'),
      'Proxy',
    ]);
  });

  it('lets the user drag tabs into a persistent order', async () => {
    render(<App />);
    const target = await screen.findByRole('button', { name: 'Target' });
    const dashboard = screen.getByRole('button', { name: t('dash.title') });
    const transfer = {
      dropEffect: 'none',
      effectAllowed: 'none',
      setData: vi.fn(),
      getData: vi.fn(),
    } as unknown as DataTransfer;

    fireEvent.dragStart(target, { dataTransfer: transfer });
    await waitFor(() => expect(target.getAttribute('aria-grabbed')).toBe('true'));
    fireEvent.dragOver(dashboard, { dataTransfer: transfer, clientX: 10 });
    await waitFor(() => expect(dashboard.className).toContain('drop-after'));
    fireEvent.drop(dashboard, { dataTransfer: transfer, clientX: 10 });

    const tabs = within(dashboard.closest('nav')!).getAllByRole('button');
    expect(tabs.slice(0, 3).map((button) => button.textContent)).toEqual([
      t('dash.title'),
      'Target',
      'Proxy',
    ]);
    expect(JSON.parse(window.localStorage.getItem(TAB_ORDER_STORAGE_KEY)!).slice(0, 3)).toEqual([
      'Dashboard',
      'Target',
      'Issues',
    ]);
  });

  it('opens the dashboard when the wordmark is clicked', async () => {
    payload = populated;
    render(<App />);

    // Navigate away first, so returning is a real state change.
    await userEvent.click(screen.getByRole('button', { name: 'Proxy' }));
    await waitFor(() => expect(screen.queryByText(t('dash.subtitle'))).toBeNull());

    await userEvent.click(screen.getByRole('button', { name: t('dash.home') }));
    expect(await screen.findByText(t('dash.subtitle'))).toBeTruthy();
  });

  it('keeps the Proxy history as it was when switching workspace tabs', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Proxy' }));

    const search = await screen.findByPlaceholderText(t('proxy.searchPlaceholder'));
    await user.type(search, 'seeded');
    await user.click(screen.getByRole('button', { name: t('filter.button') }));
    await user.type(screen.getByRole('textbox', { name: t('filter.host') }), 'example.test');
    await user.click(screen.getByRole('button', { name: t('filter.apply') }));

    const page = screen.getByRole('spinbutton', { name: t('proxy.historyPageLabel') });
    await user.clear(page);
    await user.type(page, '3');
    await user.click(screen.getByRole('button', { name: t('proxy.jumpToPage') }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) =>
      String(url).includes('offset=400')
    )).toBe(true));
    const table = document.querySelector('.flow-table-wrap') as HTMLElement;
    table.scrollTop = 40;

    await user.click(screen.getByRole('button', { name: t('dash.title') }));
    await user.click(screen.getByRole('button', { name: 'Proxy' }));

    expect(screen.getByPlaceholderText(t('proxy.searchPlaceholder'))).toBe(search);
    expect(search).toHaveProperty('value', 'seeded');
    expect(screen.getByRole('spinbutton', { name: t('proxy.historyPageLabel') })).toHaveProperty('value', '3');
    expect(document.querySelector('.flow-table-wrap')).toBe(table);
    expect(table.scrollTop).toBe(40);
    await user.click(screen.getByRole('button', { name: t('filter.buttonActive', { count: '1' }) }));
    expect(screen.getByRole('textbox', { name: t('filter.host') })).toHaveProperty('value', 'example.test');
  });

  it('starts on the dashboard', async () => {
    payload = populated;
    render(<App />);
    expect(await screen.findByText(t('dash.subtitle'))).toBeTruthy();
  });
});

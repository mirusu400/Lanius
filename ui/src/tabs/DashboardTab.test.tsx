/** Dashboard tab rendered against a mocked engine. */
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import App from '../App';
import { DashboardTab } from './DashboardTab';
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

beforeEach(() => {
  payload = empty;
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

describe('title bar', () => {
  it('opens the dashboard when the wordmark is clicked', async () => {
    payload = populated;
    render(<App />);

    // Navigate away first, so returning is a real state change.
    await userEvent.click(screen.getByRole('button', { name: 'Proxy' }));
    await waitFor(() => expect(screen.queryByText(t('dash.subtitle'))).toBeNull());

    await userEvent.click(screen.getByRole('button', { name: t('dash.home') }));
    expect(await screen.findByText(t('dash.subtitle'))).toBeTruthy();
  });

  it('starts on the dashboard', async () => {
    payload = populated;
    render(<App />);
    expect(await screen.findByText(t('dash.subtitle'))).toBeTruthy();
  });
});

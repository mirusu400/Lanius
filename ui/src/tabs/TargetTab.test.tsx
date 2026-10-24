/** Renders the real Target tab against a mocked engine. */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithI18n as render, t } from '../test-utils';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TargetTab } from './TargetTab';
import type { ScopeRule } from '../api/types';

vi.mock('../components/SitemapForceGraph', () => ({
  default: ({ selectedPath, nodes }: { selectedPath: string; nodes: { node: { path: string } }[] }) =>
    <div data-testid="force-graph" data-selected-path={selectedPath} data-selected-visible={nodes.some(({ node }) => node.path === selectedPath)} data-node-paths={JSON.stringify(nodes.map(({ node }) => node.path))} />,
}));

let rules: ScopeRule[] = [];
let restrict = false;
let calls: { url: string; method: string; body?: unknown }[] = [];
let extraPaths: typeof paths = [];
let discoveredFolders: string[] = [];
let actionContributions: Array<{
  id: string;
  plugin: string;
  title: string;
  description: string | null;
  locations: string[];
}> = [];

const sites = [
  {
    scheme: 'https',
    host: 'api.test',
    port: 443,
    flows: 4,
    paths: 3,
    last_seen: 2,
    in_scope: true,
  },
  {
    scheme: 'http',
    host: 'cdn.test',
    port: 80,
    flows: 4,
    paths: 3,
    last_seen: 1,
    in_scope: false,
  },
];

const paths = [
  {
    id: 'p1',
    method: 'GET',
    path: '/api/v1/users',
    query: null,
    status_code: 200,
    response_size: 10,
    started_at: 1,
  },
  {
    id: 'p2',
    method: 'POST',
    path: '/api/v1/login',
    query: null,
    status_code: 401,
    response_size: 5,
    started_at: 2,
  },
  // Same path, different queries: one row each, and the pile of them is
  // what made the pane scroll.
  {
    id: 'p3',
    method: 'GET',
    path: '/api/v1/users',
    query: 'page=1',
    status_code: 200,
    response_size: 10,
    started_at: 3,
  },
  {
    id: 'p4',
    method: 'GET',
    path: '/api/v1/users',
    query: 'page=2',
    status_code: 200,
    response_size: 10,
    started_at: 4,
  },
];

const endpoints = [
  {
    key: 'GET https://api.test:443/users/{id}',
    method: 'GET',
    scheme: 'https',
    host: 'api.test',
    port: 443,
    template: '/users/{id}',
    count: 7,
    path_params: ['1', '2'],
    query_params: ['page'],
    statuses: [200, 404],
    examples: ['/users/1'],
    last_seen: 3,
  },
];

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  window.localStorage.removeItem('lanius.split.sitemap.graph.requests');
  extraPaths = [];
  discoveredFolders = [];
  actionContributions = [];
  rules = [];
  restrict = false;
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });

      if (url.endsWith('/api/plugin-contributions')) {
        return jsonResponse({ actions: actionContributions });
      }
      if (url.includes('/api/plugin-actions/') && url.endsWith('/invoke')) {
        return jsonResponse({ result: {
          id: 'job-1', check_ids: ['lanius.dynamic-audit.dynamic-audit'], status: 'pending',
        } });
      }
      if (url.includes('/api/scope/from-url') && method === 'POST') {
        const created: ScopeRule = {
          id: rules.length + 1,
          kind: body.kind ?? 'include',
          host: new URL(body.url).hostname,
          path: '/*',
          protocol: 'https',
          port: null,
          match_type: 'glob',
          enabled: true,
        };
        rules = [...rules, created];
        return jsonResponse(created);
      }
      if (url.endsWith('/api/scope/rules') && method === 'POST') {
        const created: ScopeRule = { ...body, id: rules.length + 1 };
        rules = [...rules, created];
        return jsonResponse(created);
      }
      if (url.match(/\/api\/scope\/rules\/\d+$/)) {
        const id = Number(url.split('/').pop());
        if (method === 'DELETE') {
          rules = rules.filter((r) => r.id !== id);
          return jsonResponse({ ok: true });
        }
        rules = rules.map((r) => (r.id === id ? { ...r, ...body } : r));
        return jsonResponse({ rules, restrict_capture: restrict });
      }
      if (url.endsWith('/api/scope') && method === 'PATCH') {
        restrict = body.restrict_capture;
        return jsonResponse({ rules, restrict_capture: restrict });
      }
      if (url.includes('/api/scope')) {
        return jsonResponse({ rules, restrict_capture: restrict });
      }
      if (url.includes('/api/sitemap/folders')) {
        const params = new URL(url).searchParams;
        const offset = Number(params.get('offset') ?? 0);
        const limit = Number(params.get('limit') ?? 200);
        const matching = params.has('path_prefix') ? [] : discoveredFolders;
        return jsonResponse({
          items: matching.slice(offset, offset + limit),
          has_more: offset + limit < matching.length,
        });
      }
      if (url.includes('/api/sitemap/paths')) {
        const params = new URL(url).searchParams;
        const prefix = params.get('path_prefix');
        const offset = Number(params.get('offset') ?? 0);
        const limit = Number(params.get('limit') ?? 200);
        const matching = [...paths, ...extraPaths].filter((path) =>
          !prefix || path.path === prefix || path.path.startsWith(`${prefix}/`));
        const page = matching.slice(offset, offset + limit);
        return jsonResponse({
          items: params.get('host') === 'cdn.test'
            ? page.map((path) => ({ ...path, id: `cdn-${path.id}` }))
            : page,
          count: matching.length,
        });
      }
      if (url.includes('/api/sitemap')) {
        const onlyScope = url.includes('in_scope_only=true');
        const shown = (onlyScope ? sites.filter((s) => s.in_scope) : sites)
          .map((site) => site.host === 'api.test'
            ? { ...site, flows: site.flows + extraPaths.length }
            : site);
        // Old callers can still request the combined response.
        const withPaths = url.includes('with_paths=true');
        return jsonResponse({
          sites: withPaths
            ? shown.map((s) => ({
                ...s,
                path_items: s.host === 'cdn.test'
                  ? paths.map((path) => ({ ...path, id: `cdn-${path.id}` }))
                  : paths,
              }))
            : shown,
        });
      }
      if (url.includes('/api/endpoints')) {
        return jsonResponse({ items: endpoints, count: endpoints.length });
      }
      if (url.includes('/api/flows/')) {
        const parts = new URL(url).pathname.split('/');
        const id = parts.at(-1) === 'replay-request' ? parts.at(-2) : parts.at(-1);
        const path = [...paths, ...extraPaths].find((item) => item.id === id) ?? paths[0];
        return jsonResponse({
          ...path, id, type: 'http', scheme: 'https', host: 'api.test', port: 443,
          http_version: 'HTTP/1.1', request_size: 0,
          request_headers: [['Host', 'api.test']], request_body: '',
          response_headers: [], response_body: '',
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

describe('TargetTab', () => {
  it('lists captured sites', async () => {
    render(<TargetTab />);
    expect((await screen.findAllByText('https://api.test')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('http://cdn.test').length).toBeGreaterThan(0);
  });

  it('shows each host once', async () => {
    // Hosts used to appear twice, in the tree and again in a card above
    // the detail pane, which said nothing the tree did not.
    render(<TargetTab />);
    await screen.findByText('https://api.test');
    expect(screen.getAllByText('https://api.test').length).toBe(1);
    expect(document.querySelector('.site-summary')).toBeNull();
  });

  /** Text inside the tree only: both mocked sites share the same path
   *  fixture, so plain getByText would hit duplicates. */
  const treeText = () =>
    (document.querySelector('.sitemap-tree') as HTMLElement | null)
      ?.textContent ?? '';

  const treeRows = () => [
    ...document.querySelectorAll<HTMLElement>('.sitemap-tree .tree-row'),
  ];

  const rowFor = (label: string) =>
    treeRows().find(
      (row) => row.querySelector('.tree-name')?.textContent === label,
    );

  /** The map starts closed, so most tests need it opened first. */
  const expandAll = async (user: ReturnType<typeof userEvent.setup>) => {
    await waitFor(() => expect(treeRows().length).toBeGreaterThan(0));
    await user.click(screen.getByRole('button', { name: t('target.expandAll') }));
    await waitFor(() => expect(treeRows().length).toBeGreaterThan(4));
  };

  it('switches the selected host to a graph and opens captured requests', async () => {
    const user = userEvent.setup();
    render(<TargetTab />);
    await user.click(await screen.findByText('http://cdn.test'));
    await user.click(screen.getByRole('button', { name: t('target.graphView') }));
    expect((screen.getByRole('checkbox', { name: 'http://cdn.test' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'https://api.test' }) as HTMLInputElement).checked).toBe(false);
    await user.selectOptions(await screen.findByRole('combobox', { name: t('target.graphSelectPath') }), 'http://cdn.test/api');
    await user.selectOptions(await screen.findByRole('combobox', { name: t('target.graphSelectPath') }), 'http://cdn.test/api/v1');
    await user.selectOptions(await screen.findByRole('combobox', { name: t('target.graphSelectPath') }), 'http://cdn.test/api/v1/users');
    await user.click(screen.getByRole('button', { name: 'GET /api/v1/users?page=1 200' }));
    await waitFor(() => expect(calls.some((call) => call.url.includes('/api/flows/cdn-p3'))).toBe(true));
    await user.click(screen.getByRole('button', { name: t('target.graphCloseRequest') }));
    expect(screen.queryByRole('button', { name: t('target.graphCloseRequest') })).toBeNull();
    expect(calls.filter((call) => call.url.includes('/api/sitemap/paths')).every((call) => new URL(call.url).searchParams.get('host') === 'cdn.test')).toBe(true);
    await user.click(screen.getByRole('button', { name: t('target.treeView') }));
    expect(rowFor('http://cdn.test')?.classList.contains('selected')).toBe(true);
  });

  it('lists immediate child paths alongside requests and selects their graph nodes', async () => {
    extraPaths = [
      { ...paths[0], id: 'root', path: '/' },
      { ...paths[0], id: 'json1', path: '/api/apitest.json' },
      { ...paths[0], id: 'json2', path: '/api/apitest2.json' },
    ];
    const user = userEvent.setup();
    render(<TargetTab />);
    await screen.findByText('https://api.test');
    await user.click(screen.getByRole('button', { name: t('target.graphView') }));
    const panel = within(screen.getByRole('region', { name: t('target.graphRequests') }));
    await user.click(await panel.findByRole('button', { name: 'GET / 200' }));
    await waitFor(() => expect(calls.some((call) => call.url.includes('/api/flows/root'))).toBe(true));
    expect(panel.queryByRole('button', { name: 'https://api.test/api/apitest.json' })).toBeNull();
    await user.click(panel.getByRole('button', { name: 'https://api.test/api' }));
    expect(screen.getByTestId('force-graph').getAttribute('data-selected-path')).toBe('https://api.test/api');
    expect(screen.queryByRole('button', { name: t('target.graphCloseRequest') })).toBeNull();
    expect(panel.getByRole('button', { name: 'https://api.test/api/apitest.json' })).toBeTruthy();
    expect(panel.getByRole('button', { name: 'https://api.test/api/apitest2.json' })).toBeTruthy();
    await user.click(panel.getByRole('button', { name: 'https://api.test/api/apitest.json' }));
    await user.click(panel.getByRole('button', { name: 'GET /api/apitest.json 200' }));
    await waitFor(() => expect(calls.some((call) => call.url.includes('/api/flows/json1'))).toBe(true));
  });

  it('keeps an empty request panel pinned and remembers its dragged height', async () => {
    discoveredFolders = ['/empty'];
    const user = userEvent.setup();
    render(<TargetTab />);
    await screen.findByText('https://api.test');
    await user.click(screen.getByRole('button', { name: t('target.graphView') }));
    const panel = within(screen.getByRole('region', { name: t('target.graphRequests') }));
    await user.click(await panel.findByRole('button', { name: 'https://api.test/empty' }));
    await panel.findByText(t('target.graphNoRequests'));
    const split = document.querySelector('.sitemap-graph-split') as HTMLElement;
    split.getBoundingClientRect = () => ({ left: 0, top: 100, width: 1000, height: 600 }) as DOMRect;
    const separator = within(split).getByRole('separator');
    fireEvent.mouseDown(separator);
    fireEvent.mouseMove(window, { clientY: 400 });
    fireEvent.mouseUp(window);
    expect(separator.getAttribute('aria-valuenow')).toBe('50');
    expect(window.localStorage.getItem('lanius.split.sitemap.graph.requests')).toBe('0.5');
    await user.click(screen.getByRole('button', { name: t('target.treeView') }));
    await user.click(screen.getByRole('button', { name: t('target.graphView') }));
    expect(within(document.querySelector('.sitemap-graph-split') as HTMLElement).getByRole('separator').getAttribute('aria-valuenow')).toBe('50');
    expect(screen.getByRole('region', { name: t('target.graphRequests') })).toBeTruthy();
  });

  it('adds and removes host graphs independently and keeps the panel with no selection', async () => {
    const user = userEvent.setup();
    render(<TargetTab />);
    await screen.findByText('https://api.test');
    await user.click(screen.getByRole('button', { name: t('target.graphView') }));
    const graphPaths = () => JSON.parse(screen.getByTestId('force-graph').getAttribute('data-node-paths') ?? '[]') as string[];
    await waitFor(() => expect(graphPaths()).toContain('https://api.test/api/v1/users'));
    expect(calls.filter((call) => call.url.includes('/api/sitemap/paths')).every((call) => new URL(call.url).searchParams.get('host') === 'api.test')).toBe(true);
    const table = within(screen.getByRole('table', { name: t('target.graphHosts') }));
    expect(table.getByRole('columnheader', { name: t('target.graphHostRequests') })).toBeTruthy();
    expect(table.getByRole('columnheader', { name: t('target.graphHostPaths') })).toBeTruthy();
    const cdn = table.getByRole('checkbox', { name: 'http://cdn.test' });
    await user.click(cdn);
    await waitFor(() => expect(graphPaths()).toContain('http://cdn.test/api/v1/users'));
    expect(graphPaths()).toContain('https://api.test/api/v1/users');
    expect(screen.getByTestId('force-graph').getAttribute('data-selected-path')).toBe('http://cdn.test');
    await user.click(cdn);
    expect(graphPaths().every((path) => path.startsWith('https://api.test'))).toBe(true);
    await user.click(table.getByRole('checkbox', { name: 'https://api.test' }));
    expect(screen.queryByTestId('force-graph')).toBeNull();
    expect(screen.getByRole('region', { name: t('target.graphRequests') })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: t('common.refresh') }));
    await waitFor(() => expect((screen.getByRole('checkbox', { name: 'https://api.test' }) as HTMLInputElement).checked).toBe(false));
    expect(screen.queryByTestId('force-graph')).toBeNull();
    await user.click(screen.getByRole('button', { name: t('target.treeView') }));
    await user.click(screen.getByRole('button', { name: t('target.graphView') }));
    expect(screen.queryByTestId('force-graph')).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: 'http://cdn.test' }));
    await waitFor(() => expect(graphPaths()).toContain('http://cdn.test/api/v1/users'));
    expect(graphPaths().some((path) => path.startsWith('https://api.test'))).toBe(false);
  });

  it('searches the host list without hiding selected graphs', async () => {
    const user = userEvent.setup();
    render(<TargetTab />);
    await screen.findByText('https://api.test');
    await user.click(screen.getByRole('button', { name: t('target.graphView') }));
    await user.click(screen.getByRole('checkbox', { name: 'http://cdn.test' }));
    await user.type(screen.getByRole('textbox', { name: t('target.graphSearchHosts') }), 'cdn');
    expect(screen.queryByRole('checkbox', { name: 'https://api.test' })).toBeNull();
    expect(screen.getByTestId('force-graph').getAttribute('data-node-paths')).toContain('https://api.test');
    await user.click(screen.getByRole('button', { name: t('target.graphClearHosts') }));
    expect(screen.queryByTestId('force-graph')).toBeNull();
  });

  it('keeps graph pagination and scope filtering available', async () => {
    extraPaths = Array.from({ length: 205 }, (_, index) => ({ ...paths[0], id: `extra-${index}`, path: `/item-${index}` }));
    const user = userEvent.setup();
    render(<TargetTab />);
    await screen.findByText('https://api.test');
    await user.click(screen.getByRole('button', { name: t('target.graphView') }));
    await user.click(await screen.findByRole('button', { name: t('target.loadMore') }));
    await waitFor(() => expect(calls.some((call) => call.url.includes('/api/sitemap/paths') && call.url.includes('offset=200'))).toBe(true));
    await user.click(screen.getByRole('button', { name: t('target.graphMoreBranches') }));
    await user.click(screen.getByRole('checkbox', { name: 'http://cdn.test' }));
    await user.click(screen.getByRole('checkbox', { name: t('target.inScopeOnly') }));
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'http://cdn.test' })).toBeNull());
    expect((screen.getByRole('checkbox', { name: 'https://api.test' }) as HTMLInputElement).checked).toBe(true);
    await waitFor(() => expect(calls.some((call) => call.url.includes('/api/sitemap/paths') && call.url.includes('in_scope_only=true'))).toBe(true));
    const requestsBeforeRefresh = calls.filter((call) => call.url.includes('/api/sitemap/paths')).length;
    await user.click(screen.getByRole('button', { name: t('common.refresh') }));
    await waitFor(() => expect(calls.filter((call) => call.url.includes('/api/sitemap/paths')).length).toBeGreaterThan(requestsBeforeRefresh));
    expect(await screen.findByRole('button', { name: t('target.loadMore') })).toBeTruthy();
  });

  it('does not make a request per host', async () => {
    // It used to: sixty hosts meant sixty requests and sixty queries, so
    // opening this tab took seconds and got slower as the capture grew.
    render(<TargetTab />);
    await waitFor(() => expect(treeRows().length).toBeGreaterThan(0));
    const calls = vi.mocked(fetch).mock.calls.map((c) => String(c[0]));
    expect(calls.filter((u) => u.includes('/api/sitemap/paths'))).toHaveLength(0);
    expect(calls.filter((u) => u.includes('/api/sitemap'))).toHaveLength(1);
  });

  it('loads only one bounded page when a site opens, then loads more on demand', async () => {
    extraPaths = Array.from({ length: 201 }, (_, index) => ({
      id: `extra-${index}`,
      method: 'GET',
      path: `/extra/${index}`,
      query: null,
      status_code: 200,
      response_size: 1,
      started_at: index + 10,
    }));
    const user = userEvent.setup();
    render(<TargetTab />);
    await waitFor(() => expect(treeRows()).toHaveLength(2));
    expect(calls.filter((call) => call.url.includes('/api/sitemap/paths'))).toHaveLength(0);
    await user.click(rowFor('https://api.test')!);
    await screen.findByRole('button', { name: t('target.loadMore') });
    expect(calls.filter((call) => call.url.includes('/api/sitemap/paths'))).toHaveLength(1);
    expect(calls.find((call) => call.url.includes('/api/sitemap/paths'))!.url)
      .toContain('limit=200');
    await user.click(screen.getByRole('button', { name: t('target.loadMore') }));
    await waitFor(() => expect(
      calls.filter((call) => call.url.includes('/api/sitemap/paths')),
    ).toHaveLength(2));
    expect(calls.filter((call) => call.url.includes('/api/sitemap/paths'))[1].url)
      .toContain('offset=200');
    await waitFor(() => expect(screen.queryByRole('button', { name: t('target.loadMore') }))
      .toBeNull());
  });

  it('shows a folder whose requests are beyond the first site page', async () => {
    extraPaths = [
      ...Array.from({ length: 201 }, (_, index) => ({
        id: `aaa-${index}`, method: 'GET', path: `/aaa/${index}`,
        query: null, status_code: 200, response_size: 1, started_at: index + 10,
      })),
      { id: 'old', method: 'GET', path: '/zzz/old', query: null,
        status_code: 200, response_size: 1, started_at: 1 },
    ];
    discoveredFolders = ['/aaa', '/zzz'];
    const user = userEvent.setup();
    render(<TargetTab />);
    await waitFor(() => expect(rowFor('https://api.test')).toBeTruthy());
    await user.click(rowFor('https://api.test')!);
    await waitFor(() => expect(rowFor('zzz')).toBeTruthy());
    await user.click(rowFor('zzz')!);
    await waitFor(() => expect(treeText()).toContain('old'));
    expect(calls.some((call) => call.url.includes('path_prefix=%2Fzzz'))).toBe(true);
  });

  it('starts with every site closed', async () => {
    // A real capture is hundreds of hosts. Opening the spine of each one
    // filled the pane with rows to scroll past before finding anything.
    render(<TargetTab />);
    await waitFor(() => expect(treeText()).toContain('https://api.test'));
    // Two rows: one per host, and nothing underneath either of them.
    expect(treeRows().length).toBe(2);
    expect(treeText()).not.toContain('api/v1');
    expect(treeText()).not.toContain('users');
    expect(document.querySelectorAll('.tree-row.leaf').length).toBe(0);
  });

  it('shows the whole site map without clicking a site first', async () => {
    const user = userEvent.setup();
    render(<TargetTab />);
    await expandAll(user);

    const text = treeText();
    expect(text).toContain('https://api.test');
    expect(text).toContain('http://cdn.test');
    expect(text).toContain('api');
    expect(text).toContain('v1');
    expect(text).toContain('users');
    expect(text).toContain('login');
  });

  it('shows the request method and status on each leaf', async () => {
    const user = userEvent.setup();
    render(<TargetTab />);
    await expandAll(user);
    expect(treeText()).toContain('POST');
    expect(treeText()).toContain('401');
  });

  it('collapses and re-expands a branch', async () => {
    const user = userEvent.setup();
    render(<TargetTab />);
    // Both mocked sites share the path fixture, so each has its own `api`
    // node; count them to see one collapse independently of the other.
    const countRows = (label: string) =>
      treeRows().filter(
        (row) => row.querySelector('.tree-name')?.textContent === label,
      ).length;

    await expandAll(user);
    await waitFor(() => expect(countRows('v1')).toBe(2));

    await user.click(rowFor('api')!);
    await waitFor(() => expect(countRows('v1')).toBe(1));

    await user.click(rowFor('api')!);
    await waitFor(() => expect(countRows('v1')).toBe(2));
  });

  it('folds a path that only holds query variations', async () => {
    // These rows had no twisty at all: only child *nodes* made a row
    // foldable, so a path with many query strings could not be closed.
    const user = userEvent.setup();
    render(<TargetTab />);
    await expandAll(user);

    // Both mocked sites share the path fixture, so count the rows and
    // watch one site's worth disappear rather than expecting none.
    const queryRows = () =>
      [...document.querySelectorAll('.sitemap-tree .tree-row.leaf')].filter(
        (row) => row.textContent?.includes('page='),
      ).length;

    await waitFor(() => expect(queryRows()).toBe(4));
    await user.click(rowFor('users')!);
    await waitFor(() => expect(queryRows()).toBe(2));
    await user.click(rowFor('users')!);
    await waitFor(() => expect(queryRows()).toBe(4));
  });

  it('opens every level at once, and closes them again', async () => {
    const user = userEvent.setup();
    render(<TargetTab />);
    await waitFor(() => expect(treeRows().length).toBe(2));

    await user.click(screen.getByRole('button', { name: t('target.expandAll') }));
    await waitFor(() => expect(treeText()).toContain('page='));

    // The same button closes it: one control, labelled for what it does
    // next, rather than two that are each dead half the time.
    await user.click(screen.getByRole('button', { name: t('target.collapseAll') }));
    await waitFor(() => expect(treeRows().length).toBe(2));
  });

  it('opens the request detail when a leaf is selected', async () => {
    const user = userEvent.setup();
    render(<TargetTab />);
    await expandAll(user);
    await user.click(document.querySelector('.tree-row.leaf') as HTMLElement);
    await waitFor(() =>
      expect(document.querySelector('.flow-detail')).toBeTruthy(),
    );
  });

  it('offers the code formats on a request in the tree', async () => {
    // Send to Replay and Fuzzer were here already; the same request
    // could not be copied as curl without going back to the history.
    const user = userEvent.setup();
    render(<TargetTab />);
    await expandAll(user);
    fireEvent.contextMenu(document.querySelector('.tree-row.leaf') as HTMLElement);
    await user.hover(await screen.findByRole('menuitem', { name: t('menu.copyAs') }));
    expect(await screen.findByRole('menuitem', { name: 'curl' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'fetch' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Python requests' })).toBeTruthy();
  });

  it('copies the URL of a request loaded from the site map', async () => {
    const user = userEvent.setup();
    render(<TargetTab />);
    await expandAll(user);
    fireEvent.contextMenu(document.querySelector('.tree-row.leaf') as HTMLElement);
    await user.click(screen.getByRole('menuitem', { name: t('menu.copyUrl') }));
    expect(await navigator.clipboard.readText()).toBe('https://api.test/api/v1/login');
  });

  it('renders the code from the stored flow, not the tree row', async () => {
    // The tree holds a summary with no headers and no body, so rendering
    // from it would produce a command that does not repeat the request.
    const user = userEvent.setup();
    render(<TargetTab />);
    await expandAll(user);
    fireEvent.contextMenu(document.querySelector('.tree-row.leaf') as HTMLElement);
    await user.hover(await screen.findByRole('menuitem', { name: t('menu.copyAs') }));
    const curl = await screen.findByRole('menuitem', { name: 'curl' });
    fireEvent.click(curl);
    await waitFor(() => {
      const call = calls.find((c) => c.url.endsWith('/api/codegen'));
      expect(call).toBeTruthy();
      // The row the menu was opened on, whichever leaf that is.
      expect((call!.body as { flow_id: string }).flow_id).toMatch(/^p[12]$/);
      expect((call!.body as { kind: string }).kind).toBe('curl');
    });
  });

  it('deletes one request from the tree', async () => {
    // Space is the point: a capture is mostly noise and the database
    // grows without bound if the only option is clearing all of it.
    const user = userEvent.setup();
    render(<TargetTab />);
    await expandAll(user);
    fireEvent.contextMenu(document.querySelector('.tree-row.leaf') as HTMLElement);
    await user.click(await screen.findByRole('menuitem', { name: t('menu.deleteFlow') }));
    await user.click(await screen.findByRole('button', { name: t('common.delete') }));
    await waitFor(() => {
      const call = calls.find((c) => c.url.endsWith('/api/flows/delete'));
      expect((call!.body as { ids: string[] }).ids).toHaveLength(1);
    });
  });

  it('Ctrl-selects sites and deletes them in one confirmed request', async () => {
    const user = userEvent.setup();
    render(<TargetTab />);
    await waitFor(() => expect(treeRows()).toHaveLength(2));

    await user.click(rowFor('https://api.test')!);
    fireEvent.click(rowFor('http://cdn.test')!, { ctrlKey: true });
    expect(document.querySelectorAll('.sitemap-tree .tree-row.selected')).toHaveLength(2);
    fireEvent.contextMenu(rowFor('http://cdn.test')!);
    await user.click(await screen.findByRole('menuitem', {
      name: t('menu.deleteSelected', { count: 2 }),
    }));
    expect(screen.getByText(t('delete.confirmSelectedSubtrees', { items: 2 }))).toBeTruthy();
    expect(calls.some((call) => call.url.endsWith('/api/flows/delete'))).toBe(false);
    await user.click(screen.getByRole('button', { name: t('common.cancel') }));
    expect(calls.some((call) => call.url.endsWith('/api/flows/delete'))).toBe(false);

    fireEvent.contextMenu(rowFor('http://cdn.test')!);
    await user.click(await screen.findByRole('menuitem', {
      name: t('menu.deleteSelected', { count: 2 }),
    }));
    await user.click(screen.getByRole('button', { name: t('common.delete') }));
    await waitFor(() => {
      const sent = calls.filter((call) => call.url.endsWith('/api/flows/delete'));
      expect(sent).toHaveLength(1);
      const body = sent[0].body as {
        ids: string[];
        subtrees: { host: string; port: number; port_is_null: boolean; scheme: string }[];
      };
      expect(body.ids).toEqual([]);
      expect(body.subtrees).toEqual([
        { host: 'api.test', port: 443, port_is_null: false, scheme: 'https' },
        { host: 'cdn.test', port: 80, port_is_null: false, scheme: 'http' },
      ]);
    });
  });

  it('Shift-selects a visible range of requests', async () => {
    const user = userEvent.setup();
    render(<TargetTab />);
    await expandAll(user);
    const leaves = [...document.querySelectorAll<HTMLElement>('.tree-row.leaf')];
    await user.click(leaves[1]);
    fireEvent.click(leaves[3], { shiftKey: true });
    expect(document.querySelectorAll('.sitemap-tree .tree-row.selected')).toHaveLength(3);

    fireEvent.contextMenu(leaves[3]);
    await user.click(await screen.findByRole('menuitem', {
      name: t('menu.deleteSelected', { count: 3 }),
    }));
    expect(screen.getByText(t('delete.confirmSelected', { items: 3, count: 3 }))).toBeTruthy();
    await user.click(screen.getByRole('button', { name: t('common.delete') }));
    await waitFor(() => {
      const call = calls.find((item) => item.url.endsWith('/api/flows/delete'));
      expect(new Set((call!.body as { ids: string[] }).ids)).toEqual(new Set(['p1', 'p3', 'p4']));
    });
  });

  it('counts overlapping parent and child folders only once', async () => {
    const user = userEvent.setup();
    render(<TargetTab />);
    await expandAll(user);
    await user.click(rowFor('users')!);
    fireEvent.click(rowFor('api')!, { ctrlKey: true });
    fireEvent.contextMenu(rowFor('users')!);
    await user.click(await screen.findByRole('menuitem', {
      name: t('menu.deleteSelected', { count: 2 }),
    }));
    expect(screen.getByText(t('delete.confirmSelectedSubtrees', { items: 2 }))).toBeTruthy();
    await user.click(screen.getByRole('button', { name: t('common.delete') }));
    await waitFor(() => {
      const call = calls.find((item) => item.url.endsWith('/api/flows/delete'));
      expect((call!.body as { subtrees: { path_prefix: string }[] }).subtrees.map(
        (item) => item.path_prefix,
      )).toEqual(['/api', '/api/v1/users']);
    });
  });

  it('right-clicking an unselected row changes the deletion target to that row', async () => {
    const user = userEvent.setup();
    render(<TargetTab />);
    await waitFor(() => expect(treeRows()).toHaveLength(2));
    await user.click(rowFor('https://api.test')!);
    fireEvent.click(rowFor('http://cdn.test')!, { metaKey: true });

    fireEvent.contextMenu(rowFor('api')!);
    expect(document.querySelectorAll('.sitemap-tree .tree-row.selected')).toHaveLength(1);
    expect(await screen.findByRole('menuitem', { name: t('menu.deletePath') })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: t('menu.deleteSelected', { count: 2 }) })).toBeNull();
  });

  it('deletes a folder as a subtree, not as a list of ids', async () => {
    // A folder can hold thousands of requests. Sending every id would
    // be a huge request describing something the database can select.
    const user = userEvent.setup();
    render(<TargetTab />);
    await expandAll(user);
    fireEvent.contextMenu(rowFor('v1')!);
    await user.click(await screen.findByRole('menuitem', { name: t('menu.deletePath') }));
    await user.click(await screen.findByRole('button', { name: t('common.delete') }));
    await waitFor(() => {
      const call = calls.find((c) => c.url.endsWith('/api/flows/delete'));
      const body = call!.body as { path_prefix?: string; host?: string; ids?: string[] };
      expect(body.path_prefix).toBe('/api/v1');
      expect(body.host).toBe('api.test');
      expect(body.ids ?? []).toHaveLength(0);
    });
  });

  it('deletes a whole site from its top row', async () => {
    const user = userEvent.setup();
    render(<TargetTab />);
    await waitFor(() => expect(treeRows().length).toBe(2));
    fireEvent.contextMenu(rowFor('https://api.test')!);
    await user.click(await screen.findByRole('menuitem', { name: t('menu.deleteHost') }));
    await user.click(await screen.findByRole('button', { name: t('common.delete') }));
    await waitFor(() => {
      const call = calls.find((c) => c.url.endsWith('/api/flows/delete'));
      const body = call!.body as { host: string; path_prefix?: string };
      expect(body.host).toBe('api.test');
      // No path: the row is the site, not a folder inside it.
      expect(body.path_prefix).toBeUndefined();
    });
  });

  it('invokes target plugin actions with the right-clicked site identity', async () => {
    actionContributions = [{
      id: 'lanius.dynamic-audit.scan-domain',
      plugin: 'lanius.dynamic-audit',
      title: 'Dynamic scan domain',
      description: null,
      locations: ['target'],
    }];
    const user = userEvent.setup();
    render(<TargetTab />);
    await waitFor(() => expect(calls.some((call) =>
      call.url.endsWith('/api/plugin-contributions'),
    )).toBe(true));
    await waitFor(() => expect(rowFor('https://api.test')).toBeTruthy());

    fireEvent.contextMenu(rowFor('https://api.test')!);
    await user.hover(await screen.findByRole('menuitem', { name: t('plugins.actions') }));
    fireEvent.click(await screen.findByRole('menuitem', {
      name: 'Dynamic scan domain · lanius.dynamic-audit',
    }));

    await waitFor(() => {
      const invocation = calls.find((item) =>
        item.method === 'POST' && item.url.endsWith(
          '/api/plugin-actions/lanius.dynamic-audit.scan-domain/invoke',
        ));
      expect(invocation?.body).toEqual({ context: {
        location: 'target',
        target: { scheme: 'https', host: 'api.test', port: 443 },
      } });
    });
  });

  it('asks first, and deleting nothing is the default', async () => {
    const user = userEvent.setup();
    render(<TargetTab />);
    await expandAll(user);
    fireEvent.contextMenu(document.querySelector('.tree-row.leaf') as HTMLElement);
    await user.click(await screen.findByRole('menuitem', { name: t('menu.deleteFlow') }));
    // Nothing has gone yet.
    expect(calls.some((c) => c.url.endsWith('/api/flows/delete'))).toBe(false);
    await user.click(screen.getByRole('button', { name: t('common.cancel') }));
    expect(calls.some((c) => c.url.endsWith('/api/flows/delete'))).toBe(false);
  });

  it('does not understate a folder count before its page is loaded', async () => {
    const user = userEvent.setup();
    render(<TargetTab />);
    await expandAll(user);
    fireEvent.contextMenu(rowFor('users')!);
    await user.click(await screen.findByRole('menuitem', { name: t('menu.deletePath') }));
    expect(
      await screen.findByText(t('delete.confirmSubtreeUnknown', { name: 'users' })),
    ).toBeTruthy();
  });

  it('reloads the map once the deletion goes through', async () => {
    const user = userEvent.setup();
    render(<TargetTab />);
    await expandAll(user);
    const before = calls.filter((c) => c.url.includes('/api/sitemap')).length;
    fireEvent.contextMenu(document.querySelector('.tree-row.leaf') as HTMLElement);
    await user.click(await screen.findByRole('menuitem', { name: t('menu.deleteFlow') }));
    await user.click(await screen.findByRole('button', { name: t('common.delete') }));
    await waitFor(() =>
      expect(
        calls.filter((c) => c.url.includes('/api/sitemap')).length,
      ).toBeGreaterThan(before),
    );
  });

  it('adds a site to scope from the tree', async () => {
    // The cards carried the only button for this; right-clicking the
    // host row in the tree has to reach the same endpoint.
    const user = userEvent.setup();
    render(<TargetTab />);
    const host = await screen.findByText('http://cdn.test');
    fireEvent.contextMenu(host);
    await user.hover(await screen.findByRole('menuitem', { name: t('menu.scopeIncludeRule') }));
    fireEvent.click(await screen.findByRole('menuitem', { name: t('menu.scopeHostname') }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.url.endsWith('/api/scope/rules') &&
            (c.body as ScopeRule).host === 'cdn.test' &&
            (c.body as ScopeRule).path === '*',
        ),
      ).toBe(true),
    );
  });

  it('filters the sitemap to in-scope sites', async () => {
    const user = userEvent.setup();
    render(<TargetTab />);
    await screen.findByText('http://cdn.test');
    await user.click(screen.getByLabelText(t('target.inScopeOnly')));
    await waitFor(() => expect(screen.queryByText('http://cdn.test')).toBeNull());
    await user.click(rowFor('https://api.test')!);
    await waitFor(() => expect(calls.some((call) =>
      call.url.includes('/api/sitemap/paths') && call.url.includes('in_scope_only=true')
    )).toBe(true));
    expect(calls.some((call) =>
      call.url.includes('/api/sitemap/folders') && call.url.includes('in_scope_only=true')
    )).toBe(true);
  });

  it('shows grouped endpoints', async () => {
    const user = userEvent.setup();
    render(<TargetTab />);
    await user.click(await screen.findByRole('button', { name: t('target.endpoints') }));
    expect(await screen.findByText('/users/{id}')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
    expect(screen.getByText('page')).toBeTruthy();
    expect(screen.getByText('200').closest('td')?.textContent).toBe('200, 404');
  });

  it('adds and removes scope rules in the editor', async () => {
    const user = userEvent.setup();
    render(<TargetTab />);
    await user.click(await screen.findByRole('button', { name: new RegExp(t('target.scope')) }));

    await user.type(
      screen.getByLabelText(t('scope.url')),
      'https://target.com/app',
    );
    await user.click(screen.getByRole('button', { name: t('scope.addRule') }));
    expect(await screen.findByText('https://target.com/*')).toBeTruthy();

    await user.click(screen.getByLabelText(t('scope.delete', { rule: 'https://target.com/*' })));
    await waitFor(() =>
      expect(screen.queryByText('https://target.com/*')).toBeNull(),
    );
  });

  describe('editing scope rules', () => {
    beforeEach(() => {
      rules = [{ id: 42, kind: 'include', host: 'target.com', path: '/api/*',
        protocol: 'https', port: 8443, match_type: 'glob', enabled: false }];
    });

    it('saves edits on the existing rule after a double-click', async () => {
      const user = userEvent.setup();
      render(<TargetTab />);
      await user.click(await screen.findByRole('button', { name: new RegExp(t('target.scope')) }));
      await user.dblClick(await screen.findByText('https://target.com:8443/api/*'));
      const dialog = within(screen.getByRole('dialog', { name: t('scope.editRule') }));
      await user.clear(dialog.getByLabelText(t('scope.hostPattern')));
      await user.type(dialog.getByLabelText(t('scope.hostPattern')), '*.updated.test');
      await user.clear(dialog.getByLabelText(t('scope.pathPattern')));
      await user.type(dialog.getByLabelText(t('scope.pathPattern')), '/v2/*');
      await user.selectOptions(dialog.getByLabelText(t('scope.protocol')), 'any');
      await user.clear(dialog.getByLabelText(t('scope.port')));
      await user.click(dialog.getByRole('button', { name: t('scope.saveRule') }));

      expect(await screen.findByText('*://*.updated.test/v2/*')).toBeTruthy();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(rules).toEqual([{ id: 42, kind: 'include', host: '*.updated.test', path: '/v2/*',
        protocol: 'any', port: null, match_type: 'glob', enabled: false }]);
      expect(calls.filter((call) => call.method !== 'GET')).toEqual([
        { url: expect.stringContaining('/api/scope/rules/42'), method: 'PATCH',
          body: { host: '*.updated.test', path: '/v2/*', protocol: 'any', port: null } },
      ]);
    });

    it('changes the kind using the inline dropdown', async () => {
      const user = userEvent.setup();
      render(<TargetTab />);
      await user.click(await screen.findByRole('button', { name: new RegExp(t('target.scope')) }));
      const row = (await screen.findByText('https://target.com:8443/api/*')).closest('tr')!;
      await user.dblClick(within(row).getByText(t('scope.include')));
      await user.selectOptions(within(row).getByRole('combobox'), 'exclude');

      await waitFor(() => expect(within(row).queryByRole('combobox')).toBeNull());
      expect(within(row).getByText(t('scope.exclude'))).toBeTruthy();
      expect(rules[0]).toMatchObject({ id: 42, kind: 'exclude', host: 'target.com', enabled: false });
      expect(calls.filter((call) => call.method !== 'GET')).toEqual([
        { url: expect.stringContaining('/api/scope/rules/42'), method: 'PATCH', body: { kind: 'exclude' } },
      ]);
    });
  });

  it('toggles capture restriction', async () => {
    const user = userEvent.setup();
    render(<TargetTab />);
    await user.click(await screen.findByRole('button', { name: new RegExp(t('target.scope')) }));
    await user.click(screen.getByLabelText(t('scope.restrictCapture')));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === 'PATCH' &&
            c.url.endsWith('/api/scope') &&
            (c.body as { restrict_capture: boolean }).restrict_capture === true,
        ),
      ).toBe(true),
    );
  });

  it('explains that an empty include set means everything is in scope', async () => {
    const user = userEvent.setup();
    render(<TargetTab />);
    await user.click(await screen.findByRole('button', { name: new RegExp(t('target.scope')) }));

    // The hint is appended to the scope summary line.
    await waitFor(() =>
      expect(document.querySelector('.scope-summary')?.textContent).toContain(
        t('scope.noIncludeHint').trim(),
      ),
    );
  });
});

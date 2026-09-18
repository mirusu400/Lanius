/** Renders the real Target tab against a mocked engine. */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithI18n as render, t } from '../test-utils';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TargetTab } from './TargetTab';
import type { ScopeRule } from '../api/types';

let rules: ScopeRule[] = [];
let restrict = false;
let calls: { url: string; method: string; body?: unknown }[] = [];

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
    flows: 1,
    paths: 1,
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
      if (url.includes('/api/sitemap/paths')) {
        return jsonResponse({ items: paths, count: paths.length });
      }
      if (url.includes('/api/sitemap')) {
        const onlyScope = url.includes('in_scope_only=true');
        const shown = onlyScope ? sites.filter((s) => s.in_scope) : sites;
        // The server sends the paths along with the sites when asked, so
        // the tree can be built from one response.
        const withPaths = url.includes('with_paths=true');
        return jsonResponse({
          sites: withPaths
            ? shown.map((s) => ({ ...s, path_items: paths }))
            : shown,
        });
      }
      if (url.includes('/api/endpoints')) {
        return jsonResponse({ items: endpoints, count: endpoints.length });
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

  it('does not make a request per host', async () => {
    // It used to: sixty hosts meant sixty requests and sixty queries, so
    // opening this tab took seconds and got slower as the capture grew.
    render(<TargetTab />);
    await waitFor(() => expect(treeRows().length).toBeGreaterThan(0));
    const calls = vi.mocked(fetch).mock.calls.map((c) => String(c[0]));
    expect(calls.filter((u) => u.includes('/api/sitemap/paths'))).toHaveLength(0);
    expect(calls.filter((u) => u.includes('/api/sitemap'))).toHaveLength(1);
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
    // Send to Repeater and Intruder were here already; the same request
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

  it('says how much a folder would take', async () => {
    // "Delete everything under here" is unanswerable without a number.
    const user = userEvent.setup();
    render(<TargetTab />);
    await expandAll(user);
    fireEvent.contextMenu(rowFor('users')!);
    await user.click(await screen.findByRole('menuitem', { name: t('menu.deletePath') }));
    expect(
      await screen.findByText(t('delete.confirmSubtree', { count: 3, name: 'users' })),
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
    await user.click(await screen.findByText(t('menu.addToScope')));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.url.includes('/api/scope/from-url') &&
            (c.body as { url: string }).url === 'http://cdn.test',
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
  });

  it('shows grouped endpoints', async () => {
    const user = userEvent.setup();
    render(<TargetTab />);
    await user.click(await screen.findByRole('button', { name: t('target.endpoints') }));
    expect(await screen.findByText('/users/{id}')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
    expect(screen.getByText('page')).toBeTruthy();
    expect(screen.getByText('200, 404')).toBeTruthy();
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

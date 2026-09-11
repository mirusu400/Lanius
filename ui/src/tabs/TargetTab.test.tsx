/** Renders the real Target tab against a mocked engine. */
import {cleanup, screen, waitFor } from '@testing-library/react';
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
        return jsonResponse({
          sites: onlyScope ? sites.filter((s) => s.in_scope) : sites,
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
    expect(await screen.findByText('https://api.test')).toBeTruthy();
    expect(screen.getByText('http://cdn.test')).toBeTruthy();
    expect(screen.getByText(t('target.siteMeta', { flows: 4, paths: 3 }))).toBeTruthy();
  });

  it('marks in-scope sites', async () => {
    render(<TargetTab />);
    await screen.findByText('https://api.test');
    expect(screen.getAllByText(t('target.inScopeBadge'))).toHaveLength(1);
  });

  it('shows the path tree for a selected site', async () => {
    const user = userEvent.setup();
    render(<TargetTab />);
    await user.click(await screen.findByText('https://api.test'));

    // deep levels start collapsed; expanding reveals the leaves
    expect(await screen.findByText('api')).toBeTruthy();
    expect(screen.queryByText('users')).toBeNull();
    await user.click(screen.getByText('v1'));
    expect(await screen.findByText('users')).toBeTruthy();
    expect(screen.getByText('login')).toBeTruthy();
    expect(screen.getByText('POST:401')).toBeTruthy();
  });

  it('collapses an expanded tree node again', async () => {
    const user = userEvent.setup();
    render(<TargetTab />);
    await user.click(await screen.findByText('https://api.test'));
    await user.click(await screen.findByText('api'));
    await waitFor(() => expect(screen.queryByText('v1')).toBeNull());
  });

  it('adds a site to scope from the list', async () => {
    const user = userEvent.setup();
    render(<TargetTab />);
    await screen.findByText('https://api.test');
    await user.click(screen.getAllByText(t('target.addToScope'))[1]);
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
    expect(
      await screen.findByText(new RegExp(t('scope.noIncludeHint').trim())),
    ).toBeTruthy();
  });
});

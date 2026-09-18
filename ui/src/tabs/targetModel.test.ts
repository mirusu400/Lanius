import { describe, expect, it } from 'vitest';

import type { EndpointGroup, ScopeRule, Site, SitePath } from '../api/types';
import {
  buildTree,
  countFlows,
  countNodes,
  deletionTarget,
  describeRule,
  endpointHost,
  siteLabel,
  statusesUnder,
  summarizeScope,
} from './targetModel';

function site(overrides: Partial<Site> = {}): Site {
  return {
    scheme: 'https',
    host: 'api.test',
    port: 443,
    flows: 3,
    paths: 2,
    last_seen: 1,
    in_scope: true,
    ...overrides,
  };
}

function path(p: string, overrides: Partial<SitePath> = {}): SitePath {
  return {
    id: `id-${p}-${overrides.method ?? 'GET'}`,
    method: 'GET',
    path: p,
    query: null,
    status_code: 200,
    response_size: 0,
    started_at: 1,
    ...overrides,
  };
}

function rule(overrides: Partial<ScopeRule> = {}): ScopeRule {
  return {
    id: 1,
    kind: 'include',
    host: 'target.com',
    path: '/app/*',
    protocol: 'https',
    port: null,
    match_type: 'glob',
    enabled: true,
    ...overrides,
  };
}

describe('siteLabel', () => {
  it('omits default ports', () => {
    expect(siteLabel(site())).toBe('https://api.test');
    expect(siteLabel(site({ scheme: 'http', port: 80 }))).toBe(
      'http://api.test',
    );
  });

  it('keeps custom ports', () => {
    expect(siteLabel(site({ port: 8443 }))).toBe('https://api.test:8443');
  });
});

describe('buildTree', () => {
  it('nests paths by segment', () => {
    const root = buildTree([path('/api/v1/users'), path('/api/v1/orders')]);
    const api = root.children[0];
    expect(api.name).toBe('api');
    const v1 = api.children[0];
    expect(v1.name).toBe('v1');
    expect(v1.children.map((c) => c.name)).toEqual(['orders', 'users']);
  });

  it('attaches flows to their leaf node', () => {
    const root = buildTree([
      path('/a', { method: 'GET' }),
      path('/a', { method: 'POST' }),
    ]);
    expect(root.children[0].flows).toHaveLength(2);
  });

  it('puts root-level requests on the root node', () => {
    const root = buildTree([path('/')]);
    expect(root.flows).toHaveLength(1);
    expect(root.children).toHaveLength(0);
  });

  it('shares parents between sibling paths', () => {
    const root = buildTree([path('/a/b'), path('/a/c')]);
    expect(root.children).toHaveLength(1);
    expect(countNodes(root)).toBe(4); // root + a + b + c
  });

  it('handles an empty list', () => {
    const root = buildTree([]);
    expect(root.children).toHaveLength(0);
    expect(root.flows).toHaveLength(0);
  });
});

describe('describeRule', () => {
  it('renders protocol, host, port and path', () => {
    expect(describeRule(rule())).toBe('https://target.com/app/*');
    expect(describeRule(rule({ protocol: 'any', port: 8080 }))).toBe(
      '*://target.com:8080/app/*',
    );
  });

  it('marks regex rules', () => {
    expect(describeRule(rule({ match_type: 'regex' }))).toContain('(regex)');
  });
});

describe('summarizeScope', () => {
  it('counts only enabled rules', () => {
    const summary = summarizeScope([
      rule({ id: 1 }),
      rule({ id: 2, kind: 'exclude' }),
      rule({ id: 3, enabled: false }),
    ]);
    expect(summary).toEqual({ includes: 1, excludes: 1, active: 2 });
  });

  it('handles an empty rule set', () => {
    expect(summarizeScope([])).toEqual({
      includes: 0,
      excludes: 0,
      active: 0,
    });
  });
});

describe('endpointHost', () => {
  function endpoint(overrides: Partial<EndpointGroup> = {}): EndpointGroup {
    return {
      key: 'k',
      method: 'GET',
      scheme: 'http',
      host: '127.0.0.1',
      port: 19200,
      template: '/users/{id}',
      count: 1,
      path_params: [],
      query_params: [],
      statuses: [200],
      examples: [],
      last_seen: 1,
      ...overrides,
    };
  }

  it('keeps a non-default port so same-host sites stay distinct', () => {
    expect(endpointHost(endpoint())).toBe('127.0.0.1:19200');
    expect(endpointHost(endpoint({ port: 19201 }))).toBe('127.0.0.1:19201');
  });

  it('hides default ports', () => {
    expect(endpointHost(endpoint({ scheme: 'http', port: 80 }))).toBe(
      '127.0.0.1',
    );
    expect(
      endpointHost(endpoint({ scheme: 'https', port: 443, host: 'a.test' })),
    ).toBe('a.test');
  });

  it('tolerates a missing port', () => {
    expect(endpointHost(endpoint({ port: null }))).toBe('127.0.0.1');
  });
});

describe('countFlows', () => {
  it('sums requests across the whole subtree', () => {
    const root = buildTree([
      path('/a/b'),
      path('/a/c'),
      path('/a', { method: 'POST' }),
    ]);
    expect(countFlows(root)).toBe(3);
    expect(countFlows(root.children[0])).toBe(3);
  });

  it('is zero for an empty tree', () => {
    expect(countFlows(buildTree([]))).toBe(0);
  });
});

describe('statusesUnder', () => {
  it('collects distinct status codes in order', () => {
    const root = buildTree([
      path('/a', { status_code: 404 }),
      path('/a/b', { status_code: 200 }),
      path('/a/c', { status_code: 200 }),
    ]);
    expect(statusesUnder(root)).toEqual([200, 404]);
  });

  it('ignores requests with no response yet', () => {
    const root = buildTree([path('/a', { status_code: null })]);
    expect(statusesUnder(root)).toEqual([]);
  });
});

describe('deletionTarget', () => {
  /** The tree prefixes every path with the site label, so a row's path
   *  is not what the engine should be sent. */
  const node = (path: string) => ({
    name: path.split('/').pop() ?? path,
    path,
    children: [],
    flows: [],
  });

  it('strips the site label the tree added', () => {
    const s = site();
    expect(deletionTarget(node('https://api.test/api/v1'), s)?.pathPrefix).toBe(
      '/api/v1',
    );
  });

  it('sends no path for a whole site', () => {
    // A top-level row's path *is* the label, so nothing is left after
    // stripping it, and that means the site rather than a path in it.
    const s = site();
    expect(deletionTarget(node('https://api.test'), s)?.pathPrefix).toBeUndefined();
  });

  it('carries the host, port and scheme', () => {
    // Two sites can share a hostname on different ports, and the map
    // shows them separately, so deleting one must not take the other.
    const s = site({ port: 8443 });
    const target = deletionTarget(node('https://api.test:8443/x'), s);
    expect(target).toMatchObject({ host: 'api.test', port: 8443, scheme: 'https' });
  });

  it('leaves an unprefixed path alone', () => {
    expect(deletionTarget(node('/api'), site())?.pathPrefix).toBe('/api');
  });

  it('is nothing without a site', () => {
    // No site means no way to say what to delete, and a request with no
    // host would be refused by the engine anyway.
    expect(deletionTarget(node('/api'), undefined)).toBeNull();
  });
});

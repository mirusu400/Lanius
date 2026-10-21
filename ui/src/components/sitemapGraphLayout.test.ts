import { describe, expect, it } from 'vitest';
import { sitemapRows } from './SitemapTree';
import { buildTree } from '../tabs/targetModel';
import { MAX_GRAPH_NODES, layoutSitemapGraph, layoutSitemapForest } from './sitemapGraphLayout';

describe('sitemap graph layout', () => {
  it('sizes hubs by path connections and keeps every rendered edge attached', () => {
    const root = buildTree([], ['/api/users', '/api/teams', '/api/auth', '/assets']);
    const graph = layoutSitemapGraph(root, 160);
    const hub = graph.nodes.find(({ node }) => node.path === '/api')!;
    const leaf = graph.nodes.find(({ node }) => node.path === '/api/users')!;
    expect(hub.group).toBe(leaf.group);
    expect(hub.degree).toBe(4);
    expect(hub.radius).toBeGreaterThan(leaf.radius);
    expect(graph.nodes.every(({ parent }) => parent === null || graph.nodes.some(({ node }) => node.path === parent))).toBe(true);
  });

  it('includes a selected path and its ancestors beyond the initial graph page', () => {
    const root = buildTree([], [...Array.from({ length: 200 }, (_, index) => `/item-${index}`), '/z/child/leaf']);
    const graph = layoutSitemapGraph(root, 160, '/z/child/leaf');
    expect(graph.nodes.some(({ node }) => node.path === '/z/child/leaf')).toBe(true);
    expect(graph.nodes.every(({ parent }) => parent === null || graph.nodes.some(({ node }) => node.path === parent))).toBe(true);
  });

  it('keeps identical paths on separate hosts in disconnected graphs with independent budgets', () => {
    const trees = ['one.test', 'two.test'].map((host) => ({
      site: { host, scheme: 'https', port: 443, flows: 2, paths: 2, last_seen: 1, in_scope: true },
      root: buildTree([], ['/api/users', '/api/teams']),
    }));
    const roots = sitemapRows(trees).flatMap((row) => row.kind === 'node' && row.node.name.startsWith('https://') ? [row.node] : []);
    const graph = layoutSitemapForest(roots, 3);
    expect(graph.nodes).toHaveLength(6);
    expect(graph.nodes.filter(({ parent }) => parent === null)).toHaveLength(2);
    expect(new Set(graph.nodes.map(({ node }) => node.path)).size).toBe(6);
    expect(graph.nodes.every(({ node, parent }) => parent === null || new URL(node.path).host === new URL(parent).host)).toBe(true);
  });

  it('bounds the initial graph while allowing additional nodes without orphan edges', () => {
    const root = buildTree([], Array.from({ length: 500 }, (_, index) => `/api/item-${index}`));
    const first = layoutSitemapGraph(root, 160);
    const next = layoutSitemapGraph(root, 240);
    expect(first.nodes).toHaveLength(160);
    expect(first.total).toBe(502);
    expect(next.nodes).toHaveLength(240);
    expect(layoutSitemapGraph(root, 10000).nodes).toHaveLength(MAX_GRAPH_NODES);
    expect(first.nodes.every(({ node }) => next.nodes.some((entry) => entry.node.path === node.path))).toBe(true);
  });
});

it('shares a hard budget across many hosts and replaces nodes to expose a selected branch', () => {
  const trees = Array.from({ length: 10 }, (_, i) => ({
    site: { host: `host-${i}.test`, scheme: 'https', port: 443, flows: 500, paths: 500, last_seen: 1, in_scope: true },
    root: buildTree([], [...Array.from({ length: 500 }, (_, j) => `/item-${j}`), '/z/api/users', '/z/api/teams']),
  }));
  const roots = sitemapRows(trees).flatMap((row) => row.kind === 'node' && row.node.name.startsWith('https://') ? [row.node] : []);
  const graph = layoutSitemapForest(roots, 160, 'https://host-9.test/z/api');
  expect(graph.nodes).toHaveLength(MAX_GRAPH_NODES);
  expect(graph.nodes.filter(({ parent }) => parent === null)).toHaveLength(10);
  expect(graph.nodes.map(({ node }) => node.path)).toEqual(expect.arrayContaining([
    'https://host-9.test/z/api', 'https://host-9.test/z/api/users', 'https://host-9.test/z/api/teams',
  ]));
  expect(graph.nodes.every(({ parent }) => parent === null || graph.nodes.some(({ node }) => node.path === parent))).toBe(true);
  expect(graph.total).toBeGreaterThan(MAX_GRAPH_NODES);
});

it('keeps the cap even for a selected path deeper than the budget', () => {
  const path = '/' + Array.from({ length: 450 }, (_, i) => `s${i}`).join('/');
  const graph = layoutSitemapGraph(buildTree([], [path]), 160, path);
  expect(graph.nodes).toHaveLength(MAX_GRAPH_NODES);
  expect(graph.nodes.some(({ node }) => node.path === path)).toBe(true);
  expect(graph.nodes.every(({ parent }) => parent === null || graph.nodes.some(({ node }) => node.path === parent))).toBe(true);
});

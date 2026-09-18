/** Pure helpers for the Target tab (sitemap tree, scope display). */

import type { EndpointGroup, ScopeRule, Site, SitePath } from '../api/types';

export interface TreeNode {
  name: string;
  path: string;
  children: TreeNode[];
  flows: SitePath[];
  /** Set on the top level of the combined tree. */
  site?: Site;
}

/** One site plus the paths captured for it. */
export interface SiteTree {
  site: Site;
  root: TreeNode;
}

/** Total number of requests under a node, including its descendants. */
export function countFlows(node: TreeNode): number {
  return (
    node.flows.length +
    node.children.reduce((sum, child) => sum + countFlows(child), 0)
  );
}

/** Distinct status codes under a node, for an at-a-glance summary. */
export function statusesUnder(node: TreeNode): number[] {
  const seen = new Set<number>();
  const walk = (current: TreeNode) => {
    for (const flow of current.flows) {
      if (flow.status_code !== null) seen.add(flow.status_code);
    }
    current.children.forEach(walk);
  };
  walk(node);
  return [...seen].sort((a, b) => a - b);
}

/** What a site map row stands for, as a deletion target.
 *
 * Tree paths are prefixed with the site label so two hosts never share a
 * React key, and a top-level row's path *is* the label. Both have to be
 * unpicked before the path means anything to the engine, and getting it
 * wrong would delete the wrong subtree.
 */
export function deletionTarget(node: TreeNode, site: Site | undefined): {
  host?: string;
  port?: number | null;
  scheme?: string;
  pathPrefix?: string;
} | null {
  if (!site) return null;
  const label = siteLabel(site);
  const path = node.path.startsWith(label)
    ? node.path.slice(label.length)
    : node.path;
  return {
    host: site.host,
    port: site.port,
    scheme: site.scheme,
    // A host row has nothing left after the label, and means the whole
    // site rather than a path under it.
    pathPrefix: path || undefined,
  };
}

export function siteLabel(site: Site): string {
  const isDefault =
    (site.scheme === 'https' && site.port === 443) ||
    (site.scheme === 'http' && site.port === 80);
  return `${site.scheme}://${site.host}${isDefault ? '' : `:${site.port}`}`;
}

/** Host label for an endpoint, keeping a non-default port visible so two
 *  sites on the same hostname stay distinguishable. */
export function endpointHost(endpoint: EndpointGroup): string {
  const isDefault =
    (endpoint.scheme === 'https' && endpoint.port === 443) ||
    (endpoint.scheme === 'http' && endpoint.port === 80) ||
    endpoint.port === null;
  return `${endpoint.host}${isDefault ? '' : `:${endpoint.port}`}`;
}

/** Build a path tree for one site's flows. */
export function buildTree(paths: SitePath[]): TreeNode {
  const root: TreeNode = { name: '/', path: '/', children: [], flows: [] };

  for (const entry of paths) {
    const segments = (entry.path || '/').split('/').filter(Boolean);
    let node = root;
    let prefix = '';
    for (const segment of segments) {
      prefix += `/${segment}`;
      let child = node.children.find((c) => c.name === segment);
      if (!child) {
        child = { name: segment, path: prefix, children: [], flows: [] };
        node.children.push(child);
      }
      node = child;
    }
    node.flows.push(entry);
  }

  sortTree(root);
  return root;
}

function sortTree(node: TreeNode): void {
  node.children.sort((a, b) => a.name.localeCompare(b.name));
  node.children.forEach(sortTree);
}

export function countNodes(node: TreeNode): number {
  return node.children.reduce((sum, c) => sum + countNodes(c), 1);
}

/** Human-readable one-liner for a scope rule. */
export function describeRule(rule: ScopeRule): string {
  const proto = rule.protocol === 'any' ? '*' : rule.protocol;
  const port = rule.port === null ? '' : `:${rule.port}`;
  const kind = rule.match_type === 'regex' ? ' (regex)' : '';
  return `${proto}://${rule.host}${port}${rule.path}${kind}`;
}

/** Does the UI consider this site in scope? Mirrors the engine's semantics. */
export function summarizeScope(rules: ScopeRule[]): {
  includes: number;
  excludes: number;
  active: number;
} {
  const active = rules.filter((r) => r.enabled);
  return {
    includes: active.filter((r) => r.kind === 'include').length,
    excludes: active.filter((r) => r.kind === 'exclude').length,
    active: active.length,
  };
}

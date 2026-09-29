import { useCallback, useEffect, useState } from 'react';

import type { Site, SitePath } from '../api/types';
import { statusClass } from '../tabs/proxyModel';
import {
  countFlows,
  siteLabel,
  statusesUnder,
  type SiteTree,
  type TreeNode,
} from '../tabs/targetModel';
import { useT } from '../i18n';

interface Props {
  trees: SiteTree[];
  pages: Readonly<Record<string, SitePageState>>;
  onOpenNode: (node: TreeNode) => void;
  onLoadMore: (node: TreeNode) => void;
  selectedKeys: ReadonlySet<string>;
  onSelectRow: (event: React.MouseEvent, target: SitemapRowTarget) => void;
  onRowContextMenu: (event: React.MouseEvent, target: SitemapRowTarget) => void;
  /** Open/closed state, owned by the tab so its toolbar can drive it. */
  expansion: ReturnType<typeof useSitemapExpansion>;
}

export interface SitePageState {
  loaded: number;
  count: number;
  loading: boolean;
}

export type SitemapRowTarget =
  | { kind: 'flow'; flow: SitePath }
  | { kind: 'node'; node: TreeNode };

export function sitemapRowKey(target: SitemapRowTarget): string {
  return target.kind === 'flow' ? `flow:${target.flow.id}` : `node:${target.node.path}`;
}

/** Rows in visual order. Shift selection uses only rows currently visible. */
export function sitemapRows(trees: SiteTree[], expanded?: ReadonlySet<string>): SitemapRowTarget[] {
  const rows: SitemapRowTarget[] = [];
  const walk = (node: TreeNode) => {
    rows.push({ kind: 'node', node });
    if (expanded && !expanded.has(node.path)) return;
    for (const flow of node.flows) rows.push({ kind: 'flow', flow });
    node.children.forEach(walk);
  };
  for (const { site, root } of trees) {
    const label = siteLabel(site);
    walk({ ...prefixPaths(root, label, site), name: label, path: label, site });
  }
  return rows;
}

/** Requests attached to a node, one row per method + query combination. */
function FlowRows({
  flows,
  depth,
  selectedKeys,
  onSelectRow,
  onRowContextMenu,
}: {
  flows: SitePath[];
  depth: number;
  selectedKeys: ReadonlySet<string>;
  onSelectRow: Props['onSelectRow'];
  onRowContextMenu: Props['onRowContextMenu'];
}) {
  return (
    <>
      {flows.map((flow) => (
        <div
          key={flow.id}
          className={
            selectedKeys.has(`flow:${flow.id}`) ? 'tree-row leaf selected' : 'tree-row leaf'
          }
          style={{ paddingLeft: `${depth * 14 + 22}px` }}
          onClick={(event) => onSelectRow(event, { kind: 'flow', flow })}
          onContextMenu={(event) => onRowContextMenu(event, { kind: 'flow', flow })}
        >
          <span className="tree-method mono">{flow.method}</span>
          <span className="tree-query mono">
            {flow.query ? `?${flow.query}` : ''}
          </span>
          <span className={`tree-status mono ${statusClass(flow.status_code)}`}>
            {flow.status_code ?? '...'}
          </span>
        </div>
      ))}
    </>
  );
}

function Node({
  node,
  depth,
  expanded,
  toggle,
  pages,
  onOpenNode,
  onLoadMore,
  selectedKeys,
  onSelectRow,
  onRowContextMenu,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  toggle: (path: string) => void;
  pages: Props['pages'];
  onOpenNode: Props['onOpenNode'];
  onLoadMore: Props['onLoadMore'];
  selectedKeys: ReadonlySet<string>;
  onSelectRow: Props['onSelectRow'];
  onRowContextMenu: Props['onRowContextMenu'];
}) {
  const t = useT();
  // A node folds if anything hangs off it. The requests count: a path
  // with fifty query variations was a wall of rows with no way to
  // collapse it, because only child *nodes* used to make a row foldable.
  const isSite = node.site && node.path === siteLabel(node.site);
  const canFold = Boolean(isSite && node.site!.flows > 0)
    || node.children.length > 0 || node.flows.length > 0;
  const open = expanded.has(node.path);
  const page = pages[node.path];
  const total = isSite ? node.site!.flows : page?.count ?? countFlows(node);
  const statuses = statusesUnder(node);

  return (
    <div className="tree-node">
      <div
        className={selectedKeys.has(`node:${node.path}`) ? 'tree-row selected' : 'tree-row'}
        style={{ paddingLeft: `${depth * 14}px` }}
        onClick={(event) => {
          onSelectRow(event, { kind: 'node', node });
          if (canFold && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
            if (!open) onOpenNode(node);
            toggle(node.path);
          }
        }}
        onContextMenu={(event) => onRowContextMenu(event, { kind: 'node', node })}
      >
        <span className="twisty">
          {canFold ? (open ? '\u25be' : '\u25b8') : '\u00b7'}
        </span>
        <span className="mono tree-name">{node.name}</span>
        {total > 0 && <span className="tree-count">{total}</span>}
        {statuses.length > 0 && (
          <span className="tree-statuses">
            {statuses.slice(0, 4).map((code) => (
              <span key={code} className={`mono ${statusClass(code)}`}>
                {code}
              </span>
            ))}
          </span>
        )}
      </div>

      {open && (
        <>
          <FlowRows
            flows={node.flows}
            depth={depth}
            selectedKeys={selectedKeys}
            onSelectRow={onSelectRow}
            onRowContextMenu={onRowContextMenu}
          />
          {node.children.map((child) => (
            <Node
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              toggle={toggle}
              pages={pages}
              onOpenNode={onOpenNode}
              onLoadMore={onLoadMore}
              selectedKeys={selectedKeys}
              onSelectRow={onSelectRow}
              onRowContextMenu={onRowContextMenu}
            />
          ))}
          {page && page.loaded < page.count && (
            <button
              className="tree-load-more"
              disabled={page.loading}
              onClick={() => onLoadMore(node)}
            >
              {page.loading ? t('target.loading') : t('target.loadMore')}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** Every foldable path in the trees, for expand-all.
 *
 * A node folds if it holds requests or children, which is the same rule
 * the rows use; anything else has nothing to show when opened.
 */
export function allFoldablePaths(trees: SiteTree[]): Set<string> {
  const paths = new Set<string>();
  for (const { site, root } of trees) {
    const label = siteLabel(site);
    paths.add(label);
    const walk = (node: TreeNode) => {
      for (const child of node.children) {
        if (child.children.length > 0 || child.flows.length > 0) {
          paths.add(`${label}${child.path}`);
        }
        walk(child);
      }
    };
    walk(root);
  }
  return paths;
}

/** Which nodes are open, kept here so the Target tab's toolbar can drive
 *  expand-all and collapse-all without owning the tree's internals. */
export function useSitemapExpansion(trees: SiteTree[]) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [expandAllActive, setExpandAllActive] = useState(false);

  // Everything starts closed. Opening the spine of every site sounded
  // helpful, but a real capture is hundreds of hosts and the map opened
  // as a page of rows you had to scroll past to find anything.
  useEffect(() => {
    const valid = allFoldablePaths(trees);
    setExpanded((current) => expandAllActive
      ? valid
      : new Set([...current].filter((path) => valid.has(path))));
  }, [trees, expandAllActive]);

  const toggle = useCallback((path: string) => {
    setExpandAllActive(false);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const expandAll = useCallback(() => {
    setExpandAllActive(true);
    setExpanded(allFoldablePaths(trees));
  }, [trees]);

  const collapseAll = useCallback(() => {
    setExpandAllActive(false);
    setExpanded(new Set());
  }, []);

  return { expanded, toggle, expandAll, collapseAll, anyOpen: expanded.size > 0 };
}

export function SitemapTree({
  trees,
  pages,
  onOpenNode,
  onLoadMore,
  selectedKeys,
  onSelectRow,
  onRowContextMenu,
  expansion,
}: Props) {
  const t = useT();
  const { expanded, toggle } = expansion;

  if (trees.length === 0) {
    return <p className="muted pad">{t('target.noSites')}</p>;
  }

  return (
    <div className="sitemap-tree">
      {trees.map(({ site, root }) => {
        const label = siteLabel(site);
        // Prefix child paths with the site so two hosts never share a key.
        const prefixed = prefixPaths(root, label, site);
        return (
          <Node
            key={label}
            node={{ ...prefixed, name: label, path: label, site }}
            depth={0}
            expanded={expanded}
            toggle={toggle}
            pages={pages}
            onOpenNode={onOpenNode}
            onLoadMore={onLoadMore}
            selectedKeys={selectedKeys}
            onSelectRow={onSelectRow}
            onRowContextMenu={onRowContextMenu}
          />
        );
      })}
    </div>
  );
}

/** Prefixes paths with the site label and carries the site down.
 *
 * The label keeps two hosts from sharing a React key. The site is
 * attached to every node, not just the top one, because acting on a row
 * (deleting the subtree it stands for) needs to know which site it
 * belongs to, and a nested row had no way to find out.
 */
function prefixPaths(node: TreeNode, prefix: string, site: Site): TreeNode {
  return {
    ...node,
    site,
    path: `${prefix}${node.path}`,
    children: node.children.map((child) => prefixPaths(child, prefix, site)),
  };
}

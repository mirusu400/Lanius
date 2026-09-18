import { useCallback, useEffect, useState } from 'react';

import type { SitePath } from '../api/types';
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
  selectedFlowId: string | null;
  onSelectFlow: (flow: SitePath) => void;
  /** Right-click on a request row. */
  onFlowContextMenu?: (event: React.MouseEvent, flow: SitePath) => void;
  /** Right-click on a folder, which stands for a path prefix. */
  onNodeContextMenu?: (event: React.MouseEvent, node: TreeNode) => void;
  /** Open/closed state, owned by the tab so its toolbar can drive it. */
  expansion: ReturnType<typeof useSitemapExpansion>;
}

/** Requests attached to a node, one row per method + query combination. */
function FlowRows({
  flows,
  depth,
  selectedFlowId,
  onSelectFlow,
  onFlowContextMenu,
}: {
  flows: SitePath[];
  depth: number;
  selectedFlowId: string | null;
  onSelectFlow: (flow: SitePath) => void;
  onFlowContextMenu?: (event: React.MouseEvent, flow: SitePath) => void;
}) {
  return (
    <>
      {flows.map((flow) => (
        <div
          key={flow.id}
          className={
            flow.id === selectedFlowId ? 'tree-row leaf selected' : 'tree-row leaf'
          }
          style={{ paddingLeft: `${depth * 14 + 22}px` }}
          onClick={() => onSelectFlow(flow)}
          onContextMenu={(event) => {
            // Act on the row that was clicked, not the current selection.
            onSelectFlow(flow);
            onFlowContextMenu?.(event, flow);
          }}
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
  selectedFlowId,
  onSelectFlow,
  onFlowContextMenu,
  onNodeContextMenu,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  toggle: (path: string) => void;
  selectedFlowId: string | null;
  onSelectFlow: (flow: SitePath) => void;
  onFlowContextMenu?: (event: React.MouseEvent, flow: SitePath) => void;
  onNodeContextMenu?: (event: React.MouseEvent, node: TreeNode) => void;
}) {
  // A node folds if anything hangs off it. The requests count: a path
  // with fifty query variations was a wall of rows with no way to
  // collapse it, because only child *nodes* used to make a row foldable.
  const canFold = node.children.length > 0 || node.flows.length > 0;
  const open = expanded.has(node.path);
  const total = countFlows(node);
  const statuses = statusesUnder(node);

  return (
    <div className="tree-node">
      <div
        className="tree-row"
        style={{ paddingLeft: `${depth * 14}px` }}
        onClick={() => canFold && toggle(node.path)}
        onContextMenu={(event) => onNodeContextMenu?.(event, node)}
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
            selectedFlowId={selectedFlowId}
            onSelectFlow={onSelectFlow}
            onFlowContextMenu={onFlowContextMenu}
          />
          {node.children.map((child) => (
            <Node
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              toggle={toggle}
              selectedFlowId={selectedFlowId}
              onSelectFlow={onSelectFlow}
              onFlowContextMenu={onFlowContextMenu}
              onNodeContextMenu={onNodeContextMenu}
            />
          ))}
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

  // Everything starts closed. Opening the spine of every site sounded
  // helpful, but a real capture is hundreds of hosts and the map opened
  // as a page of rows you had to scroll past to find anything.
  useEffect(() => {
    setExpanded(new Set());
  }, [trees]);

  const toggle = useCallback((path: string) => {
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
    setExpanded(allFoldablePaths(trees));
  }, [trees]);

  const collapseAll = useCallback(() => setExpanded(new Set()), []);

  return { expanded, toggle, expandAll, collapseAll, anyOpen: expanded.size > 0 };
}

export function SitemapTree({
  trees,
  selectedFlowId,
  onSelectFlow,
  onFlowContextMenu,
  onNodeContextMenu,
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
        const prefixed = prefixPaths(root, label);
        return (
          <Node
            key={label}
            node={{ ...prefixed, name: label, path: label, site }}
            depth={0}
            expanded={expanded}
            toggle={toggle}
            selectedFlowId={selectedFlowId}
            onSelectFlow={onSelectFlow}
            onFlowContextMenu={onFlowContextMenu}
            onNodeContextMenu={onNodeContextMenu}
          />
        );
      })}
    </div>
  );
}

function prefixPaths(node: TreeNode, prefix: string): TreeNode {
  return {
    ...node,
    path: `${prefix}${node.path}`,
    children: node.children.map((child) => prefixPaths(child, prefix)),
  };
}

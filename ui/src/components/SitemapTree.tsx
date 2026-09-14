import { useEffect, useMemo, useState } from 'react';

import type { SitePath } from '../api/types';
import { statusClass } from '../tabs/proxyModel';
import {
  countFlows,
  defaultExpanded,
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
  const hasChildren = node.children.length > 0;
  // A leaf has nothing to fold, so its requests are always visible; only
  // nodes with children participate in expand/collapse.
  const open = hasChildren ? expanded.has(node.path) : true;
  const total = countFlows(node);
  const statuses = statusesUnder(node);

  return (
    <div className="tree-node">
      <div
        className="tree-row"
        style={{ paddingLeft: `${depth * 14}px` }}
        onClick={() => hasChildren && toggle(node.path)}
        onContextMenu={(event) => onNodeContextMenu?.(event, node)}
      >
        <span className="twisty">
          {hasChildren ? (open ? '\u25be' : '\u25b8') : '\u00b7'}
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

export function SitemapTree({
  trees,
  selectedFlowId,
  onSelectFlow,
  onFlowContextMenu,
  onNodeContextMenu,
}: Props) {
  const t = useT();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [touched, setTouched] = useState(false);

  // Open each site and the spine of its tree, so the map is readable at a
  // glance instead of a list of collapsed hosts. A user toggle takes over.
  const initial = useMemo(() => {
    const open = new Set<string>();
    for (const { site, root } of trees) {
      open.add(siteLabel(site));
      for (const path of defaultExpanded(root)) {
        open.add(`${siteLabel(site)}${path}`);
      }
    }
    return open;
  }, [trees]);

  useEffect(() => {
    if (!touched) setExpanded(initial);
  }, [initial, touched]);

  const toggle = (path: string) => {
    setTouched(true);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

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

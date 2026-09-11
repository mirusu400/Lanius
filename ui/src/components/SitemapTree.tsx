import { useState } from 'react';

import type { TreeNode } from '../tabs/targetModel';
import { statusClass } from '../tabs/proxyModel';

function Node({ node, depth }: { node: TreeNode; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  const hasChildren = node.children.length > 0;

  return (
    <div className="tree-node">
      <div
        className="tree-row"
        style={{ paddingLeft: `${depth * 14}px` }}
        onClick={() => hasChildren && setOpen((o) => !o)}
      >
        <span className="twisty">{hasChildren ? (open ? '▾' : '▸') : '·'}</span>
        <span className="mono">{node.name}</span>
        {node.flows.length > 0 && (
          <span className="tree-flows">
            {node.flows.map((flow) => (
              <span
                key={flow.id}
                className={`mono ${statusClass(flow.status_code)}`}
                title={`${flow.method} ${flow.path}`}
              >
                {flow.method}:{flow.status_code ?? '…'}
              </span>
            ))}
          </span>
        )}
      </div>
      {open &&
        node.children.map((child) => (
          <Node key={child.path} node={child} depth={depth + 1} />
        ))}
    </div>
  );
}

export function SitemapTree({ root }: { root: TreeNode }) {
  if (root.children.length === 0 && root.flows.length === 0) {
    return <p className="muted pad">이 사이트에는 기록된 경로가 없습니다.</p>;
  }
  return (
    <div className="sitemap-tree">
      <Node node={root} depth={0} />
    </div>
  );
}

import type { TreeNode } from '../tabs/targetModel';

// Shared by all selected hosts, including paths brought into view by navigation.
export const MAX_GRAPH_NODES = 400;

export interface GraphNode {
  node: TreeNode;
  parent: string | null;
  group: string;
  degree: number;
  radius: number;
}

type Entry = { node: TreeNode; parent: string | null; group: string; host: number };

export function layoutSitemapGraph(root: TreeNode, limit: number, selectedPath?: string) {
  return layoutSitemapForest([root], limit, selectedPath);
}

/** Share a hard canvas budget across hosts; navigation replaces less relevant nodes. */
export function layoutSitemapForest(roots: TreeNode[], limitPerHost: number, selectedPath?: string) {
  const queues = roots.map((root, host) => {
    const queue: Entry[] = [{ node: root, parent: null, group: root.path, host }];
    for (let index = 0; index < queue.length; index++) {
      const entry = queue[index];
      for (const node of entry.node.children) {
        queue.push({ node, parent: entry.node.path, group: index === 0 ? node.path : entry.group, host });
      }
    }
    return queue;
  });
  const entries = queues.flat();
  const byPath = new Map(entries.map((entry) => [entry.node.path, entry]));
  const included = new Map<string, Entry>();
  const counts = roots.map(() => 0);
  const perHost = Math.max(1, Math.min(MAX_GRAPH_NODES, limitPerHost));
  const add = (entry: Entry) => {
    if (included.has(entry.node.path) || included.size >= MAX_GRAPH_NODES) return false;
    included.set(entry.node.path, entry);
    counts[entry.host]++;
    return true;
  };
  const focus = selectedPath ? byPath.get(selectedPath) : undefined;
  const chain: Entry[] = [];
  for (let entry = focus; entry; entry = entry.parent ? byPath.get(entry.parent) : undefined) chain.push(entry);
  // Extremely deep paths still obey the cap: show the nearest ancestors as a subtree.
  chain.slice(0, MAX_GRAPH_NODES).reverse().forEach(add);
  queues.forEach((queue) => add(queue[0]));

  // Reserve part of the budget for immediate children of the selected path. The
  // remaining slots are round-robin breadth-first, so large hosts cannot starve others.
  if (focus) {
    const allowance = Math.min(80, Math.floor((MAX_GRAPH_NODES - included.size) / 2), perHost - counts[focus.host]);
    let added = 0;
    for (const child of focus.node.children) {
      if (added >= allowance) break;
      if (add(byPath.get(child.path)!)) added++;
    }
  }
  const cursors = roots.map(() => 0);
  let progress = true;
  while (included.size < MAX_GRAPH_NODES && progress) {
    progress = false;
    queues.forEach((queue, host) => {
      if (counts[host] >= perHost) return;
      while (cursors[host] < queue.length) {
        const entry = queue[cursors[host]++];
        if (included.has(entry.node.path) || (entry.parent && !included.has(entry.parent))) continue;
        if (add(entry)) progress = true;
        break;
      }
    });
  }
  const nodes: GraphNode[] = entries.filter(({ node }) => included.has(node.path)).map(({ node, parent, group }) => {
    const degree = node.children.length + (parent ? 1 : 0);
    return { node, parent: parent && included.has(parent) ? parent : null, group, degree, radius: Math.min(30, 5 + Math.sqrt(degree) * 3) };
  });
  return { nodes, total: entries.length };
}

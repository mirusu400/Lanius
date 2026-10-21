import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';

import type { SitePath } from '../api/types';
import { useT } from '../i18n';
import { Split } from './Split';
import { statusClass } from '../tabs/proxyModel';
import { siteLabel, type SiteTree, type TreeNode } from '../tabs/targetModel';
import { layoutSitemapForest, MAX_GRAPH_NODES } from './sitemapGraphLayout';
import { sitemapRows, type FolderPageState, type SitePageState } from './SitemapTree';

const SitemapForceGraph = lazy(() => import('./SitemapForceGraph'));

interface Props {
  trees: SiteTree[];
  resetKey: number;
  hosts: string[] | null;
  onHostsChange: (hosts: string[]) => void;
  pages: Readonly<Record<string, SitePageState>>;
  folderPages: Readonly<Record<string, FolderPageState>>;
  onOpenNode: (node: TreeNode) => void;
  onLoadMore: (node: TreeNode) => void;
  onLoadMoreFolders: (node: TreeNode) => void;
  onSelectFlow: (flow: SitePath | null) => void;
}

/** Host selection is explicit: an empty selection stays empty, including after refresh. */
export function SitemapGraph(props: Props) {
  const t = useT();
  const { trees, hosts, onHostsChange, onSelectFlow } = props;
  const [search, setSearch] = useState('');
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const selectedHosts = useMemo(() => hosts ?? (trees[0] ? [siteLabel(trees[0].site)] : []), [hosts, trees]);
  const selectedTrees = useMemo(() => {
    const available = new Map(trees.map((tree) => [siteLabel(tree.site), tree]));
    return selectedHosts.flatMap((host) => available.has(host) ? [available.get(host)!] : []);
  }, [trees, selectedHosts]);
  const selected = new Set(selectedTrees.map(({ site }) => siteLabel(site)));
  const shownTrees = trees.filter(({ site }) => siteLabel(site).toLowerCase().includes(search.trim().toLowerCase()));
  const toggleHost = (host: string) => {
    const next = selected.has(host) ? selectedHosts.filter((value) => value !== host) : [...selectedHosts, host];
    onHostsChange(next);
    onSelectFlow(null);
    if (!selected.has(host)) setFocusPath(host);
  };
  return <Split direction="horizontal" storageKey="lanius.split.sitemap.graph.hosts" initial={0.26}
    className="sitemap-graph-host-layout"
    first={<section className="sitemap-hosts" aria-label={t('target.graphHosts')}>
      <div className="sitemap-hosts-heading">
        <strong>{t('target.graphHosts')}</strong>
        <span className="muted">{t('target.graphSelectedHosts', { count: selected.size })}</span>
        <button disabled={selected.size === 0} onClick={() => { onHostsChange([]); onSelectFlow(null); }}>{t('target.graphClearHosts')}</button>
      </div>
      <input className="sitemap-host-search" aria-label={t('target.graphSearchHosts')} placeholder={t('target.graphSearchHosts')}
        value={search} onChange={(event) => setSearch(event.target.value)} />
      <div className="sitemap-host-table-scroll">
        <table className="sitemap-host-table" aria-label={t('target.graphHosts')}>
          <thead><tr><th aria-label={t('target.graphSelectHost')} /><th>{t('target.graphHost')}</th><th>{t('target.graphHostRequests')}</th><th>{t('target.graphHostPaths')}</th></tr></thead>
          <tbody>{shownTrees.map(({ site }) => {
            const host = siteLabel(site);
            return <tr key={host} className={selected.has(host) ? 'selected' : ''}
              onClick={() => toggleHost(host)} tabIndex={0}
              onKeyDown={(event) => {
                if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
                  event.preventDefault(); toggleHost(host);
                }
              }}>
              <td><input type="checkbox" aria-label={host} checked={selected.has(host)}
                onClick={(event) => event.stopPropagation()} onChange={() => toggleHost(host)} /></td>
              <td className="mono" title={host}>{host}</td>
              <td className="mono">{site.flows.toLocaleString()}</td>
              <td className="mono">{site.paths.toLocaleString()}</td>
            </tr>;
          })}</tbody>
        </table>
        {shownTrees.length === 0 && <p className="muted pad">{trees.length === 0 ? t('target.noSites') : t('target.graphNoMatchingHosts')}</p>}
      </div>
    </section>}
    second={<div className="sitemap-graph">
      <SelectedHostGraphs {...props} trees={selectedTrees} focusPath={focusPath} onFocusPath={setFocusPath} />
    </div>}
  />;
}

function SelectedHostGraphs({ trees, focusPath, onFocusPath, resetKey, pages, folderPages, onOpenNode, onLoadMore, onLoadMoreFolders, onSelectFlow }: Props & {
  focusPath: string | null;
  onFocusPath: (path: string) => void;
}) {
  const t = useT();
  const [visibleCount, setVisibleCount] = useState(160);
  const nodes = useMemo(() => sitemapRows(trees).flatMap((row) => row.kind === 'node' ? [row.node] : []), [trees]);
  const roots = useMemo(() => nodes.filter((node) => node.site && node.path === siteLabel(node.site)), [nodes]);
  const focus = nodes.find((node) => node.path === focusPath) ?? roots[0];
  const focusHost = focus?.site ? siteLabel(focus.site) : '';
  useEffect(() => { onSelectFlow(null); }, [focusHost, onSelectFlow]);
  const label = focus?.site ? siteLabel(focus.site) : '';
  const page = focus ? pages[focus.path] : undefined;
  const folderPage = focus ? folderPages[focus.path] : undefined;
  const attempted = useRef({ resetKey, paths: new Set<string>() });
  useEffect(() => {
    if (attempted.current.resetKey !== resetKey) attempted.current = { resetKey, paths: new Set() };
    // Only selected hosts load data. A removed host can finish an in-flight page into
    // the cache, but cannot put its nodes back into this graph.
    for (const node of [...roots, ...(focus ? [focus] : [])]) {
      if (attempted.current.paths.has(node.path)) continue;
      attempted.current.paths.add(node.path);
      onOpenNode(node);
    }
  }, [roots, focus, resetKey, onOpenNode]);
  const navigate = (node: TreeNode) => {
    onSelectFlow(null);
    onFocusPath(node.path);
    onOpenNode(node);
  };
  const ancestors = nodes.filter((node) => node.path === label || focus?.path.startsWith(`${node.path}/`));
  const graph = useMemo(() => layoutSitemapForest(roots, visibleCount, focus?.path), [roots, visibleCount, focus?.path]);
  const isHost = focus?.path === label;
  const loading = page?.loading || folderPage?.loading;
  return <>
    <div className="sitemap-graph-toolbar">
      <nav aria-label={t('target.graphPath')} className="sitemap-graph-breadcrumbs">
        {ancestors.filter((node) => node.path !== focus?.path).map((node) => <button key={node.path} onClick={() => navigate(node)}>{node.path === label ? node.site?.host : node.name}<span aria-hidden="true"> /</span></button>)}
        <span className="mono" title={focus?.path}>{focus ? isHost ? focus.site?.host : focus.name : t('target.graphSelectHostsHint')}</span>
      </nav>
      <select aria-label={t('target.graphSelectPath')} value={focus?.path ?? ''} disabled={!focus} onChange={(event) => {
        const node = nodes.find((node) => node.path === event.target.value);
        if (node) navigate(node);
      }}>
        {nodes.map((node) => <option key={node.path} value={node.path}>{node.path}</option>)}
      </select>
    </div>
    <p className="sitemap-graph-hint muted">{t('target.graphHint')}</p>
    <Split direction="vertical" storageKey="lanius.split.sitemap.graph.requests" initial={0.7}
      className="sitemap-graph-split"
      first={<div className="sitemap-graph-upper">
        <div className="sitemap-graph-viewport" role="region" aria-label={t('target.graphView')}>
          {focus ? <Suspense fallback={<p className="muted pad">{t('target.loading')}</p>}>
            <SitemapForceGraph nodes={graph.nodes} selectedPath={focus.path} onSelectNode={navigate} />
          </Suspense> : <div className="sitemap-graph-unselected muted">{t('target.graphSelectHostsHint')}</div>}
          <div className="sitemap-network-legend"><span aria-hidden="true">●</span> {t('target.graphSizeHint')} · {t('target.graphVisible', { shown: graph.nodes.length, total: graph.total })}</div>
        </div>
        {graph.total > graph.nodes.length && <div className="sitemap-graph-pagination">
          {graph.nodes.length < MAX_GRAPH_NODES && <button onClick={() => setVisibleCount((count) => Math.min(MAX_GRAPH_NODES, count + 80))}>{t('target.graphMoreBranches')}</button>}
          <span className="muted">{t('target.graphBudgetHint', { count: MAX_GRAPH_NODES })}</span>
        </div>}
      </div>}
      second={<section className="sitemap-graph-requests" aria-label={t('target.graphRequests')}>
        <div className="sitemap-graph-requests-heading">
          <span>{t('target.graphRequests')}</span>
          <span className="mono muted" title={focus?.path}>{focus?.path ?? ''}</span>
        </div>
        <div className="sitemap-graph-request-list">
          {focus?.flows.map((flow) => <button key={flow.id} onClick={() => onSelectFlow(flow)} className="sitemap-graph-request mono">
            <span className="tree-method">{flow.method}</span>{' '}
            <span className="sitemap-graph-request-path">{flow.path}{flow.query ? `?${flow.query}` : ''}</span>{' '}
            <span className={statusClass(flow.status_code)}>{flow.status_code ?? '…'}</span>
          </button>)}
          {focus?.children.map((child) => <button key={child.path} className="sitemap-graph-request sitemap-graph-child mono"
            aria-label={child.path} title={child.path} onClick={() => navigate(child)}>
            <span className="sitemap-graph-folder-icon" aria-hidden="true">▸</span>
            <span className="sitemap-graph-request-path">{child.path.slice(label.length)}</span>
            <span className="muted">{t('target.graphOpenPath')}</span>
          </button>)}
          {(!focus || (focus.flows.length === 0 && focus.children.length === 0)) && <p className="muted sitemap-graph-empty">
            {!focus ? t('target.graphSelectHostsHint') : loading ? t('target.loading') : t('target.graphNoRequests')}
          </p>}
        </div>
        <div className="sitemap-graph-pagination" aria-live="polite">
          {loading && <span className="muted">{t('target.loading')}</span>}
          {focus && page && page.loaded < page.count && <button disabled={page.loading} onClick={() => onLoadMore(focus)}>{t('target.loadMore')}</button>}
          {focus && folderPage?.hasMore && <button disabled={folderPage.loading} onClick={() => onLoadMoreFolders(focus)}>{t('target.loadMoreFolders')}</button>}
          {focus && !loading && (!page || !folderPage) && <button onClick={() => onOpenNode(focus)}>{t('common.refresh')}</button>}
        </div>
      </section>}
    />
  </>;
}

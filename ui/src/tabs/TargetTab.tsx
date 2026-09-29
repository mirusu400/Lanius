import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  addScopeFromUrl,
  deleteFlows,
  deleteScopeRule,
  getEndpoints,
  getScope,
  getFlow,
  getSitemap,
  getSitePaths,
  getSiteFolders,
  patchScopeRule,
  setRestrictCapture,
} from '../api/client';
import type {
  EndpointGroup,
  FlowDetail,
  FlowSummary,
  ScopeState,
  Site,
  SitePath,
} from '../api/types';
import { ScopeEditor } from '../components/ScopeEditor';
import {
  SitemapTree,
  sitemapRowKey,
  sitemapRows,
  useSitemapExpansion,
  type SitePageState,
  type FolderPageState,
  type SitemapRowTarget,
} from '../components/SitemapTree';
import { ContextMenu, useContextMenu, type MenuItem } from '../components/ContextMenu';
import { useReportBusy } from '../components/busy';
import { useCodegenMenu } from '../components/useCodegenMenu';
import { usePluginActions } from '../components/usePluginActions';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { sendToRepeater } from './repeaterStore';
import { sendToIntruder } from './intruderStore';
import {
  buildTree,
  deletionTarget,
  siteLabel,
  type SiteTree,
  type TreeNode,
} from './targetModel';
import { FlowDetailView } from '../components/FlowDetail';
import { EndpointExplorer } from '../components/EndpointExplorer';
import { Split } from '../components/Split';
import { connectStream } from '../api/stream';
import { msg, rawMsg, renderMessage, useT, type Message } from '../i18n';

type View = 'sitemap' | 'endpoints' | 'scope';

function flowIdsUnder(node: TreeNode): string[] {
  return [
    ...node.flows.map((flow) => flow.id),
    ...node.children.flatMap(flowIdsUnder),
  ];
}

export function TargetTab() {
  const t = useT();
  const [view, setView] = useState<View>('sitemap');
  const [sites, setSites] = useState<Site[]>([]);
  const [sitePaths, setSitePaths] = useState<Record<string, SitePath[]>>({});
  const [pages, setPages] = useState<Record<string, SitePageState>>({});
  const [siteFolders, setSiteFolders] = useState<Record<string, string[]>>({});
  const [folderPages, setFolderPages] = useState<Record<string, FolderPageState>>({});
  const folderPagesRef = useRef(folderPages);
  useEffect(() => { folderPagesRef.current = folderPages; }, [folderPages]);
  const loadingFolders = useRef(new Set<string>());
  const pagesRef = useRef(pages);
  useEffect(() => { pagesRef.current = pages; }, [pages]);
  const loadingPages = useRef(new Set<string>());
  const pageGeneration = useRef(0);
  const [trees, setTrees] = useState<SiteTree[]>([]);
  const [selectedFlow, setSelectedFlow] = useState<SitePath | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [anchorKey, setAnchorKey] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<FlowSummary | null>(null);
  const [endpoints, setEndpoints] = useState<EndpointGroup[]>([]);
  const endpointsRef = useRef(endpoints);
  endpointsRef.current = endpoints;
  const [endpointCount, setEndpointCount] = useState(0);
  const [loadingEndpoints, setLoadingEndpoints] = useState(false);
  const endpointRefreshGeneration = useRef(0);
  const endpointRefreshInFlight = useRef(false);
  const lastEndpointRefresh = useRef(0);
  const [scope, setScope] = useState<ScopeState>({
    rules: [],
    restrict_capture: false,
  });
  const [inScopeOnly, setInScopeOnly] = useState(false);
  const [error, setError] = useState<Message | null>(null);
  // Only the first load: a refresh triggered by arriving traffic should
  // not throw a spinner over a map you are reading.
  const [loading, setLoading] = useState(true);

  useReportBusy('target', loading);

  const menu = useContextMenu<{ clicked: SitemapRowTarget; selected: SitemapRowTarget[] }>();
  const codegen = useCodegenMenu(setError);
  const expansion = useSitemapExpansion(trees);
  const visibleRows = useMemo(
    () => sitemapRows(trees, expansion.expanded),
    [trees, expansion.expanded],
  );
  const selectedRows = useMemo(
    () => {
      const seen = new Set<string>();
      return visibleRows.filter((row) => {
        const key = sitemapRowKey(row);
        if (!selectedKeys.has(key) || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    },
    [visibleRows, selectedKeys],
  );

  const selectRow = (event: React.MouseEvent, target: SitemapRowTarget) => {
    const key = sitemapRowKey(target);
    const additive = event.ctrlKey || event.metaKey;
    if (event.shiftKey) {
      event.preventDefault();
      const keys = visibleRows.map(sitemapRowKey);
      const start = anchorKey === null ? -1 : keys.indexOf(anchorKey);
      const end = keys.indexOf(key);
      if (start >= 0 && end >= 0) {
        const range = keys.slice(Math.min(start, end), Math.max(start, end) + 1);
        setSelectedKeys((current) => new Set(additive ? [...current, ...range] : range));
      } else {
        setSelectedKeys(new Set([key]));
        setAnchorKey(key);
      }
    } else if (additive) {
      setSelectedKeys((current) => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      setAnchorKey(key);
    } else {
      setSelectedKeys(new Set([key]));
      setAnchorKey(key);
    }
    if (target.kind === 'flow') setSelectedFlow(target.flow);
  };

  const openRowMenu = (event: React.MouseEvent, target: SitemapRowTarget) => {
    const key = sitemapRowKey(target);
    const selected = selectedKeys.has(key) && selectedRows.length > 0
      ? selectedRows : [target];
    if (!selectedKeys.has(key)) {
      setSelectedKeys(new Set([key]));
      setAnchorKey(key);
    }
    if (target.kind === 'flow') setSelectedFlow(target.flow);
    menu.open(event, { clicked: target, selected });
  };
  const refreshScope = useCallback(async () => {
    try {
      setScope(await getScope());
    } catch (err) {
      setError(rawMsg((err as Error).message));
    }
  }, []);

  const refreshSites = useCallback(async () => {
    try {
      const data = await getSitemap(inScopeOnly);
      setSites(data.sites);
      setError(null);
    } catch (err) {
      setError(msg('target.sitemapFailed', { message: (err as Error).message }));
    } finally {
      setLoading(false);
    }
  }, [inScopeOnly]);
  const pluginActions = usePluginActions(
    (message) => setError(rawMsg(message)),
    () => void refreshSites(),
  );

  const resetPages = useCallback(() => {
    pageGeneration.current += 1;
    loadingPages.current.clear();
    loadingFolders.current.clear();
    setSitePaths({});
    setPages({});
    setSiteFolders({});
    setFolderPages({});
  }, []);

  const loadFolders = useCallback(async (node: TreeNode) => {
    const site = node.site;
    if (!site || loadingFolders.current.has(node.path)) return;
    const target = deletionTarget(node, site);
    if (!target) return;
    const offset = folderPagesRef.current[node.path]?.loaded ?? 0;
    const generation = pageGeneration.current;
    loadingFolders.current.add(node.path);
    setFolderPages((current) => ({ ...current, [node.path]: {
      loaded: offset, hasMore: current[node.path]?.hasMore ?? false, loading: true,
    } }));
    try {
      const result = await getSiteFolders(site.host, site.scheme, site.port, {
        offset, pathPrefix: target.pathPrefix, inScopeOnly,
      });
      if (generation !== pageGeneration.current) return;
      setSiteFolders((current) => ({ ...current,
        [node.path]: [...new Set([...(current[node.path] ?? []), ...result.items])],
      }));
      setFolderPages((current) => ({ ...current, [node.path]: {
        loaded: offset + result.items.length, hasMore: result.has_more, loading: false,
      } }));
    } catch (err) {
      if (generation === pageGeneration.current) {
        setError(msg('target.sitemapFailed', { message: (err as Error).message }));
        setFolderPages((current) => {
          const next = { ...current };
          delete next[node.path];
          return next;
        });
      }
    } finally {
      loadingFolders.current.delete(node.path);
      if (generation === pageGeneration.current) setFolderPages((current) => ({ ...current,
        ...(current[node.path] ? { [node.path]: { ...current[node.path], loading: false } } : {}),
      }));
    }
  }, [inScopeOnly]);

  const loadPage = useCallback(async (node: TreeNode) => {
    const site = node.site;
    if (!site || loadingPages.current.has(node.path)) return;
    const target = deletionTarget(node, site);
    if (!target) return;
    const offset = pagesRef.current[node.path]?.loaded ?? 0;
    const generation = pageGeneration.current;
    loadingPages.current.add(node.path);
    setPages((current) => ({
      ...current,
      [node.path]: {
        loaded: offset,
        count: current[node.path]?.count ?? 0,
        loading: true,
      },
    }));
    try {
      const result = await getSitePaths(site.host, site.scheme, site.port, {
        limit: 200, offset, pathPrefix: target.pathPrefix, inScopeOnly,
      });
      if (pageGeneration.current !== generation) return;
      const label = siteLabel(site);
      setSitePaths((current) => {
        const byId = new Map((current[label] ?? []).map((flow) => [flow.id, flow]));
        result.items.forEach((flow) => byId.set(flow.id, flow));
        return { ...current, [label]: [...byId.values()] };
      });
      setPages((current) => ({
        ...current,
        [node.path]: {
          loaded: result.items.length === 0 ? result.count : offset + result.items.length,
          count: result.count,
          loading: false,
        },
      }));
    } catch (err) {
      if (pageGeneration.current === generation) {
        setError(msg('target.sitemapFailed', { message: (err as Error).message }));
        setPages((current) => {
          const next = { ...current };
          delete next[node.path];
          return next;
        });
      }
    } finally {
      if (pageGeneration.current === generation) {
        loadingPages.current.delete(node.path);
        setPages((current) => ({
          ...current,
          ...(current[node.path]
            ? { [node.path]: { ...current[node.path], loading: false } }
            : {}),
        }));
      }
    }
  }, [inScopeOnly]);

  const openNode = useCallback((node: TreeNode) => {
    if (!pagesRef.current[node.path]) void loadPage(node);
    if (!folderPagesRef.current[node.path]) void loadFolders(node);
  }, [loadPage, loadFolders]);

  const refreshEndpoints = useCallback(async (force = true) => {
    if (!force && (endpointRefreshInFlight.current || Date.now() - lastEndpointRefresh.current < 30_000)) return;
    const generation = ++endpointRefreshGeneration.current;
    endpointRefreshInFlight.current = true;
    setLoadingEndpoints(true);
    try {
      const data = await getEndpoints(
        undefined, inScopeOnly, Math.min(20_000, Math.max(200, endpointsRef.current.length)),
      );
      if (generation !== endpointRefreshGeneration.current) return;
      setEndpoints(data.items);
      setEndpointCount(data.count);
      lastEndpointRefresh.current = Date.now();
    } catch (err) {
      if (generation === endpointRefreshGeneration.current) setError(rawMsg((err as Error).message));
    } finally {
      if (generation === endpointRefreshGeneration.current) {
        endpointRefreshInFlight.current = false;
        setLoadingEndpoints(false);
      }
    }
  }, [inScopeOnly]);

  const [pendingDelete, setPendingDelete] = useState<SitemapRowTarget[] | null>(null);

  /** What the confirmation says, and what it will remove. */
  const deletion = useMemo(() => {
    if (!pendingDelete?.length) return null;
    if (pendingDelete.length > 1) {
      const previewIds = new Set<string>();
      const idsToDelete = new Set<string>();
      const subtrees: { host: string; port: number | null; scheme: string; pathPrefix?: string }[] = [];
      for (const target of pendingDelete) {
        if (target.kind === 'flow') {
          previewIds.add(target.flow.id);
          idsToDelete.add(target.flow.id);
        } else {
          const nodeIds = flowIdsUnder(target.node);
          nodeIds.forEach((id) => previewIds.add(id));
          const subtree = deletionTarget(target.node, target.node.site);
          if (subtree?.host && subtree.scheme) {
            subtrees.push({
              host: subtree.host,
              port: subtree.port ?? null,
              scheme: subtree.scheme,
              pathPrefix: subtree.pathPrefix,
            });
          } else {
            nodeIds.forEach((id) => idsToDelete.add(id));
          }
        }
      }
      return {
        message: subtrees.length > 0
          ? t('delete.confirmSelectedSubtrees', { items: pendingDelete.length })
          : t('delete.confirmSelected', {
              items: pendingDelete.length,
              count: previewIds.size,
            }),
        run: () => deleteFlows({
          ids: [...idsToDelete],
          subtrees,
        }),
      };
    }
    const selected = pendingDelete[0];
    if (selected.kind === 'flow') {
      const { flow } = selected;
      return {
        message: t('delete.confirmFlow'),
        run: () => deleteFlows({ ids: [flow.id] }),
      };
    }
    const { node } = selected;
    const target = deletionTarget(node, node.site);
    if (!target) return null;
    const isSite = Boolean(node.site && node.path === siteLabel(node.site));
    const deleteCount = isSite
      ? node.site?.flows
      : inScopeOnly ? undefined : pages[node.path]?.count;
    return {
      // Says how many and which folder: "delete everything under here"
      // is not a question anyone can answer without those two facts.
      message: deleteCount !== undefined
        ? t('delete.confirmSubtree', {
            count: deleteCount,
            name: node.name,
          })
        : t('delete.confirmSubtreeUnknown', { name: node.name }),
      run: () => target.host
        ? deleteFlows(target)
        : deleteFlows({ ids: flowIdsUnder(node) }),
    };
  }, [pendingDelete, pages, inScopeOnly, t]);

  const runDeletion = useCallback(async () => {
    const pending = deletion;
    setPendingDelete(null);
    if (!pending) return;
    try {
      await pending.run();
      setSelectedFlow(null);
      setSelectedKeys(new Set());
      setAnchorKey(null);
      resetPages();
      expansion.collapseAll();
      await refreshSites();
    } catch (err) {
      setError(rawMsg((err as Error).message));
    }
  }, [deletion, refreshSites, resetPages, expansion]);

  useEffect(() => {
    void refreshScope();
  }, [refreshScope]);

  useEffect(() => {
    void refreshSites();
  }, [refreshSites]);

  useEffect(() => {
    resetPages();
  }, [inScopeOnly, resetPages]);

  // Refresh the map as traffic arrives, coalescing bursts so a busy proxy
  // does not trigger a reload per request.
  useEffect(() => {
    let timer: number | undefined;
    const schedule = () => {
      if (timer) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        void refreshSites();
        if (view === 'endpoints') void refreshEndpoints(false);
      }, 1500);
    };
    const disconnect = connectStream({
      onEvent: (event) => {
        if (event.type === 'flow.response' || event.type === 'flows.cleared') {
          schedule();
        }
      },
    });
    return () => {
      if (timer) window.clearTimeout(timer);
      disconnect();
    };
  }, [refreshSites, refreshEndpoints, view]);

  // A site remains light until it is opened; pages are merged by flow ID.
  useEffect(() => {
    if (sites.length === 0) {
      setTrees([]);
      return;
    }
    // The paths arrive with the sites, so the trees are built from what
    // is already in hand rather than fetched again.
    setTrees(
      sites.map((site) => {
        const label = siteLabel(site);
        const folders = Object.entries(siteFolders)
          .filter(([key]) => key === label || key.startsWith(`${label}/`))
          .flatMap(([, paths]) => paths);
        return { site, root: buildTree(sitePaths[label] ?? [], folders) };
      }),
    );
  }, [sites, sitePaths, siteFolders]);

  useEffect(() => {
    if (view !== 'endpoints') return;
    void refreshEndpoints();
  }, [view, refreshEndpoints]);

  // The tree only carries a path summary, so load the full flow for the
  // shared detail pane.
  useEffect(() => {
    if (!selectedFlow) {
      setSelectedDetail(null);
      return;
    }
    let cancelled = false;
    getFlow(selectedFlow.id)
      .then((flow) => {
        if (!cancelled) setSelectedDetail(flow);
      })
      .catch(() => {
        if (!cancelled) setSelectedDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedFlow]);

  return (
    <div className="target-tab">
      <div className="subtabs">
        <button
          className={view === 'sitemap' ? 'active' : ''}
          onClick={() => setView('sitemap')}
        >
          {t('target.sitemap')}
        </button>
        <button
          className={view === 'endpoints' ? 'active' : ''}
          onClick={() => setView('endpoints')}
        >
          {t('target.endpoints')}
        </button>
        <button
          className={view === 'scope' ? 'active' : ''}
          onClick={() => setView('scope')}
        >
          {t('target.scope')}
          {scope.rules.length > 0 && (
            <span className="badge">{scope.rules.length}</span>
          )}
        </button>
        <span className="spacer" />
        <label className="scope-filter">
          <input
            type="checkbox"
            checked={inScopeOnly}
            onChange={(e) => setInScopeOnly(e.target.checked)}
          />
          {t('target.inScopeOnly')}
        </label>
        {view === 'sitemap' && (expansion.anyOpen ||
          (sites.length <= 20 && sites.every((site) => site.flows <= 200))) && (
          <button
            onClick={() => {
              if (expansion.anyOpen) {
                expansion.collapseAll();
                return;
              }
              expansion.expandAll();
              sites.forEach((site) => {
                const label = siteLabel(site);
                void loadPage({ name: label, path: label, site, children: [], flows: [] });
                void loadFolders({ name: label, path: label, site, children: [], flows: [] });
              });
            }}
          >
            {expansion.anyOpen ? t('target.collapseAll') : t('target.expandAll')}
          </button>
        )}
        <button onClick={() => {
          resetPages();
          expansion.collapseAll();
          void refreshSites();
          if (view === 'endpoints') void refreshEndpoints();
        }}>{t('common.refresh')}</button>
      </div>

      {error && <div className="banner error">{renderMessage(error, t)}</div>}

      {view === 'scope' ? (
        <ScopeEditor
          scope={scope}
          onAddUrl={async (url, kind, regex) => {
            await addScopeFromUrl(url, kind, regex);
            resetPages();
            await refreshScope();
            await refreshSites();
          }}
          onToggle={async (id, enabled) => {
            setScope(await patchScopeRule(id, { enabled }));
            resetPages();
            await refreshSites();
          }}
          onDelete={async (id) => {
            await deleteScopeRule(id);
            resetPages();
            await refreshScope();
            await refreshSites();
          }}
          onRestrictCapture={async (value) => {
            setScope(await setRestrictCapture(value));
          }}
        />
      ) : view === 'endpoints' ? (
        <EndpointExplorer
          endpoints={endpoints}
          loadingEndpoints={loadingEndpoints}
          endpointCount={endpointCount}
          onLoadMoreEndpoints={async () => {
            const data = await getEndpoints(undefined, inScopeOnly, 200, endpoints.length);
            setEndpoints((current) => {
              const byKey = new Map(current.map((item) => [item.key, item]));
              data.items.forEach((item) => byKey.set(item.key, item));
              return [...byKey.values()];
            });
            setEndpointCount(data.count);
          }}
          inScopeOnly={inScopeOnly}
          onChanged={async () => {
            resetPages();
            await Promise.all([refreshScope(), refreshSites(), refreshEndpoints()]);
          }}
        />
      ) : (
        <Split
          direction="horizontal"
          storageKey="lanius.split.sitemap"
          initial={0.46}
          className="proxy-split"
          first={<div className="sitemap-pane">
            <p className="sitemap-selection-hint">
              {selectedRows.length > 1
                ? t('target.selectedRows', { count: selectedRows.length })
                : t('target.multiSelectHint')}
            </p>
            <SitemapTree
              trees={trees}
              pages={pages}
              folderPages={folderPages}
              onOpenNode={openNode}
              onLoadMore={(node) => void loadPage(node)}
              onLoadMoreFolders={(node) => void loadFolders(node)}
              selectedKeys={selectedKeys}
              onSelectRow={selectRow}
              onRowContextMenu={openRowMenu}
              expansion={expansion}
            />
            <ConfirmDialog
              open={deletion !== null}
              title={t('menu.deleteFlow')}
              message={deletion?.message ?? ''}
              confirmLabel={t('common.delete')}
              onCancel={() => setPendingDelete(null)}
              onConfirm={() => void runDeletion()}
            />
            <ContextMenu
              position={menu.position}
              items={
                menu.target
                  ? menu.target.selected.length > 1
                    ? [{
                        label: t('menu.deleteSelected', { count: menu.target.selected.length }),
                        danger: true,
                        onSelect: () => setPendingDelete(menu.target!.selected),
                      }]
                    : treeMenuItems(
                        menu.target.clicked,
                        t,
                        () => {
                          resetPages();
                          void Promise.all([refreshScope(), refreshSites(), refreshEndpoints()]);
                        },
                        codegen,
                        (target) => setPendingDelete([target]),
                        menu.target.clicked.kind === 'flow'
                          ? pluginActions.buildMenu(
                              ['flow'],
                              {
                                flow_id: menu.target.clicked.flow.id,
                                flow: menu.target.clicked.flow,
                              },
                            )
                          : undefined,
                      )
                  : []
              }
              onClose={menu.close}
            />
          </div>}
          second={<div className="site-detail">
            {selectedDetail && <FlowDetailView flow={selectedDetail} splitStorageKey="lanius.split.sitemap.detail" initialSplit={0.35} />}
          </div>}
        />
      )}
    </div>
  );
}

/** What right-clicking the site map offers.
 *
 * A folder in the tree stands for a path prefix, so scoping it is the
 * action people reach for; a request row behaves like one in the history.
 */
function treeMenuItems(
  target: SitemapRowTarget,
  t: ReturnType<typeof useT>,
  onScopeChanged: () => void,
  codegen: ReturnType<typeof useCodegenMenu>,
  onDelete: (target: SitemapRowTarget) => void,
  pluginActions?: MenuItem,
): MenuItem[] {
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text);
  };

  if (target.kind === 'node') {
    const { node } = target;
    const site = node.site;
    const url = site
      ? `${site.scheme}://${site.host}${node.path.startsWith('/') ? node.path : ''}`
      : node.path;
    return [
      {
        label: t('menu.addToScope'),
        onSelect: () => {
          void addScopeFromUrl(url)
            .then(onScopeChanged)
            .catch(() => undefined);
        },
      },
      { label: t('menu.copyPath'), separator: true, onSelect: () => copy(node.path) },
      ...(site
        ? [{ label: t('menu.copyHost'), onSelect: () => copy(site.host) }]
        : []),
      // A folder stands for a subtree, so this removes everything under
      // it in one request rather than a few thousand ids.
      ...(site
        ? [
            {
              label: node.site && node.path === siteLabel(node.site)
                ? t('menu.deleteHost')
                : t('menu.deletePath'),
              separator: true,
              danger: true,
              onSelect: () => onDelete(target),
            },
          ]
        : []),
    ];
  }

  const { flow } = target;
  // The tree only carries a summary, so fetch the request before sending
  // it on; otherwise Repeater would open with no headers or body.
  const withDetail = (send: (detail: FlowDetail) => void) => () => {
    void getFlow(flow.id)
      .then(send)
      .catch(() => undefined);
  };

  return [
    {
      label: t('menu.sendToRepeater'),
      onSelect: withDetail((detail) => sendToRepeater(detail, detail)),
    },
    {
      label: t('menu.sendToIntruder'),
      onSelect: withDetail((detail) => sendToIntruder(detail)),
    },
    {
      label: t('menu.copyPath'),
      separator: true,
      onSelect: () => copy(flow.path ?? ''),
    },
    // Rendered from the stored flow's id, so the engine uses the headers
    // and body it captured rather than the summary this tree holds.
    codegen.buildMenu({ flow_id: flow.id }),
    ...(pluginActions ? [pluginActions] : []),
    {
      label: t('menu.deleteFlow'),
      separator: true,
      danger: true,
      onSelect: () => onDelete(target),
    },
  ];
}

import { useCallback, useEffect, useState } from 'react';

import {
  addScopeFromUrl,
  deleteScopeRule,
  getEndpoints,
  getScope,
  getFlow,
  getSitemap,
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
import { SitemapTree } from '../components/SitemapTree';
import { ContextMenu, useContextMenu, type MenuItem } from '../components/ContextMenu';
import { useReportBusy } from '../components/busy';
import { sendToRepeater } from './repeaterStore';
import { sendToIntruder } from './intruderStore';
import {
  buildTree,
  endpointHost,
  siteLabel,
  type SiteTree,
  type TreeNode,
} from './targetModel';
import { FlowDetailView } from '../components/FlowDetail';
import { connectStream } from '../api/stream';
import { msg, rawMsg, renderMessage, useT, type Message } from '../i18n';

type View = 'sitemap' | 'endpoints' | 'scope';

export function TargetTab() {
  const t = useT();
  const [view, setView] = useState<View>('sitemap');
  const [sites, setSites] = useState<Site[]>([]);
  const [trees, setTrees] = useState<SiteTree[]>([]);
  const [selectedFlow, setSelectedFlow] = useState<SitePath | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<FlowSummary | null>(null);
  const [endpoints, setEndpoints] = useState<EndpointGroup[]>([]);
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

  const menu = useContextMenu<TreeMenuTarget>();

  const refreshScope = useCallback(async () => {
    try {
      setScope(await getScope());
    } catch (err) {
      setError(rawMsg((err as Error).message));
    }
  }, []);

  const refreshSites = useCallback(async () => {
    try {
      // Ask for the paths in the same request: one round trip instead of
      // one per host, which is what made opening this tab take seconds.
      const data = await getSitemap(inScopeOnly, true);
      setSites(data.sites);
      setError(null);
    } catch (err) {
      setError(msg('target.sitemapFailed', { message: (err as Error).message }));
    } finally {
      setLoading(false);
    }
  }, [inScopeOnly]);

  useEffect(() => {
    void refreshScope();
  }, [refreshScope]);

  useEffect(() => {
    void refreshSites();
  }, [refreshSites]);

  // Refresh the map as traffic arrives, coalescing bursts so a busy proxy
  // does not trigger a reload per request.
  useEffect(() => {
    let timer: number | undefined;
    const schedule = () => {
      if (timer) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        void refreshSites();
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
  }, [refreshSites]);

  // Load the paths of every site up front: the map should be readable
  // without clicking a host first.
  useEffect(() => {
    if (sites.length === 0) {
      setTrees([]);
      return;
    }
    // The paths arrive with the sites, so the trees are built from what
    // is already in hand rather than fetched again.
    setTrees(
      sites.map((site) => ({ site, root: buildTree(site.path_items ?? []) })),
    );
  }, [sites]);

  useEffect(() => {
    if (view !== 'endpoints') return;
    getEndpoints(undefined, inScopeOnly)
      .then((data) => setEndpoints(data.items))
      .catch(() => setEndpoints([]));
  }, [view, inScopeOnly]);

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

  const addSiteToScope = async (site: Site) => {
    try {
      await addScopeFromUrl(siteLabel(site));
      await refreshScope();
      await refreshSites();
    } catch (err) {
      setError(rawMsg((err as Error).message));
    }
  };

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
        <button onClick={() => void refreshSites()}>{t('common.refresh')}</button>
      </div>

      {error && <div className="banner error">{renderMessage(error, t)}</div>}

      {view === 'scope' ? (
        <ScopeEditor
          scope={scope}
          onAddUrl={async (url, kind) => {
            await addScopeFromUrl(url, kind);
            await refreshScope();
            await refreshSites();
          }}
          onToggle={async (id, enabled) => {
            setScope(await patchScopeRule(id, { enabled }));
            await refreshSites();
          }}
          onDelete={async (id) => {
            await deleteScopeRule(id);
            await refreshScope();
            await refreshSites();
          }}
          onRestrictCapture={async (value) => {
            setScope(await setRestrictCapture(value));
          }}
        />
      ) : view === 'endpoints' ? (
        <div className="endpoint-list">
          <table className="flow-table">
            <thead>
              <tr>
                <th className="col-method">{t('flow.method')}</th>
                <th className="col-host">{t('flow.host')}</th>
                <th>{t('target.endpoint')}</th>
                <th className="col-size">{t('target.count')}</th>
                <th>{t('target.params')}</th>
                <th className="col-host">{t('target.statuses')}</th>
              </tr>
            </thead>
            <tbody>
              {endpoints.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty">
                    {t('target.noEndpoints')}
                  </td>
                </tr>
              )}
              {endpoints.map((endpoint) => (
                <tr key={endpoint.key}>
                  <td className="mono">{endpoint.method}</td>
                  <td className="mono">{endpointHost(endpoint)}</td>
                  <td className="mono">{endpoint.template}</td>
                  <td className="mono num">{endpoint.count}</td>
                  <td className="mono">
                    {endpoint.query_params.map((p) => (
                      <span key={p} className="param">
                        {p}
                      </span>
                    ))}
                  </td>
                  <td className="mono">{endpoint.statuses.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="proxy-split">
          <div className="sitemap-pane">
            <SitemapTree
              trees={trees}
              selectedFlowId={selectedFlow?.id ?? null}
              onSelectFlow={setSelectedFlow}
              onFlowContextMenu={(event, flow) =>
                menu.open(event, { kind: 'flow', flow })
              }
              onNodeContextMenu={(event, node) =>
                menu.open(event, { kind: 'node', node })
              }
            />
            <ContextMenu
              position={menu.position}
              items={menu.target ? treeMenuItems(menu.target, t, refreshScope) : []}
              onClose={menu.close}
            />
          </div>
          <div className="site-detail">
            <div className="site-summary">
              {sites.map((site) => (
                <div
                  key={`${site.scheme}-${site.host}-${site.port}`}
                  className="site"
                >
                  <div className="site-name mono">
                    {siteLabel(site)}
                    {site.in_scope && (
                      <span className="in-scope">
                        {t('target.inScopeBadge')}
                      </span>
                    )}
                  </div>
                  <div className="site-meta muted">
                    {t('target.siteMeta', {
                      flows: site.flows,
                      paths: site.paths,
                    })}
                  </div>
                  <button
                    className="add-scope"
                    onClick={() => void addSiteToScope(site)}
                  >
                    {t('target.addToScope')}
                  </button>
                </div>
              ))}
            </div>
            {selectedDetail && <FlowDetailView flow={selectedDetail} />}
          </div>
        </div>
      )}
    </div>
  );
}

type TreeMenuTarget =
  | { kind: 'flow'; flow: SitePath }
  | { kind: 'node'; node: TreeNode };

/** What right-clicking the site map offers.
 *
 * A folder in the tree stands for a path prefix, so scoping it is the
 * action people reach for; a request row behaves like one in the history.
 */
function treeMenuItems(
  target: TreeMenuTarget,
  t: ReturnType<typeof useT>,
  onScopeChanged: () => void,
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
  ];
}

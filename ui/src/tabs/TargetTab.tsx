import { useCallback, useEffect, useState } from 'react';

import {
  addScopeFromUrl,
  deleteScopeRule,
  getEndpoints,
  getScope,
  getSitePaths,
  getSitemap,
  patchScopeRule,
  setRestrictCapture,
} from '../api/client';
import type {
  EndpointGroup,
  ScopeState,
  Site,
  SitePath,
} from '../api/types';
import { ScopeEditor } from '../components/ScopeEditor';
import { SitemapTree } from '../components/SitemapTree';
import { buildTree, endpointHost, siteLabel } from './targetModel';

type View = 'sitemap' | 'endpoints' | 'scope';

export function TargetTab() {
  const [view, setView] = useState<View>('sitemap');
  const [sites, setSites] = useState<Site[]>([]);
  const [selected, setSelected] = useState<Site | null>(null);
  const [paths, setPaths] = useState<SitePath[]>([]);
  const [endpoints, setEndpoints] = useState<EndpointGroup[]>([]);
  const [scope, setScope] = useState<ScopeState>({
    rules: [],
    restrict_capture: false,
  });
  const [inScopeOnly, setInScopeOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshScope = useCallback(async () => {
    try {
      setScope(await getScope());
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const refreshSites = useCallback(async () => {
    try {
      const data = await getSitemap(inScopeOnly);
      setSites(data.sites);
      setError(null);
    } catch (err) {
      setError(`사이트맵을 불러오지 못했습니다: ${(err as Error).message}`);
    }
  }, [inScopeOnly]);

  useEffect(() => {
    void refreshScope();
  }, [refreshScope]);

  useEffect(() => {
    void refreshSites();
  }, [refreshSites]);

  useEffect(() => {
    if (!selected) {
      setPaths([]);
      return;
    }
    getSitePaths(selected.host, selected.scheme, selected.port)
      .then((data) => setPaths(data.items))
      .catch(() => setPaths([]));
  }, [selected]);

  useEffect(() => {
    if (view !== 'endpoints') return;
    getEndpoints(selected?.host, inScopeOnly)
      .then((data) => setEndpoints(data.items))
      .catch(() => setEndpoints([]));
  }, [view, selected, inScopeOnly]);

  const addSiteToScope = async (site: Site) => {
    try {
      await addScopeFromUrl(siteLabel(site));
      await refreshScope();
      await refreshSites();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="target-tab">
      <div className="subtabs">
        <button
          className={view === 'sitemap' ? 'active' : ''}
          onClick={() => setView('sitemap')}
        >
          Site map
        </button>
        <button
          className={view === 'endpoints' ? 'active' : ''}
          onClick={() => setView('endpoints')}
        >
          Endpoints
        </button>
        <button
          className={view === 'scope' ? 'active' : ''}
          onClick={() => setView('scope')}
        >
          Scope
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
          스코프만 보기
        </label>
        <button onClick={() => void refreshSites()}>새로고침</button>
      </div>

      {error && <div className="banner error">{error}</div>}

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
                <th className="col-method">Method</th>
                <th className="col-host">Host</th>
                <th>Endpoint</th>
                <th className="col-size">Count</th>
                <th>Params</th>
                <th className="col-host">Statuses</th>
              </tr>
            </thead>
            <tbody>
              {endpoints.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty">
                    엔드포인트가 없습니다. 트래픽을 캡처하면 경로가 템플릿으로
                    묶여 표시됩니다.
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
          <div className="site-list">
            {sites.length === 0 && (
              <p className="muted pad">아직 캡처된 사이트가 없습니다.</p>
            )}
            {sites.map((site) => (
              <div
                key={`${site.scheme}-${site.host}-${site.port}`}
                className={
                  selected &&
                  selected.host === site.host &&
                  selected.scheme === site.scheme &&
                  selected.port === site.port
                    ? 'site selected'
                    : 'site'
                }
                onClick={() => setSelected(site)}
              >
                <div className="site-name mono">
                  {siteLabel(site)}
                  {site.in_scope && <span className="in-scope">scope</span>}
                </div>
                <div className="site-meta muted">
                  {site.flows} flows · {site.paths} paths
                </div>
                <button
                  className="add-scope"
                  onClick={(e) => {
                    e.stopPropagation();
                    void addSiteToScope(site);
                  }}
                >
                  + scope
                </button>
              </div>
            ))}
          </div>
          <div className="site-detail">
            {selected ? (
              <SitemapTree root={buildTree(paths)} />
            ) : (
              <p className="muted pad">
                사이트를 선택하면 경로 트리가 표시됩니다.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

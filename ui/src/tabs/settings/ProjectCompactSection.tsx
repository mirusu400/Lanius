/** Inspect and reclaim project storage without touching scope or settings. */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  compactProject,
  getCompactOverview,
  type CompactOverview,
  type CompactSite,
} from '../../api/client';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useT } from '../../i18n';
import { formatBytes } from '../dashboardModel';
import { ResizableHeader, ResizableTable, useResizableColumns } from '../../components/ResizableColumns';

const siteKey = (site: CompactSite) => JSON.stringify([site.scheme, site.host, site.port]);

export function ProjectCompactSection() {
  const t = useT();
  const columns = useResizableColumns('lanius.columns.compact', [360, 130, 110, 150]);
  const [overview, setOverview] = useState<CompactOverview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const refresh = useCallback(async () => {
    setOverview(await getCompactOverview());
  }, []);

  useEffect(() => {
    void refresh().catch((err: unknown) => setError(String(err)));
  }, [refresh]);

  const selectedSites = useMemo(
    () => overview?.sites.filter((site) => selected.has(siteKey(site))) ?? [],
    [overview, selected],
  );
  const selectedFlows = selectedSites.reduce((sum, site) => sum + site.flows, 0);
  const visibleSites = overview?.sites.filter((site) =>
    `${site.scheme ?? ''} ${site.host ?? ''} ${site.port ?? ''}`
      .toLowerCase().includes(filter.toLowerCase()),
  ) ?? [];

  const run = async (sites: CompactSite[]) => {
    setConfirmDelete(false);
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const data = await compactProject(sites);
      setResult(t(sites.length ? 'compact.deleted' : 'compact.compacted', {
        deleted: data.deleted,
        bytes: formatBytes(data.reclaimed_bytes),
      }));
      if (data.reclaim_error) {
        setError(t('compact.reclaimFailed', { message: data.reclaim_error }));
      }
      setSelected(new Set());
      await refresh();
    } catch (err) {
      setError(t('compact.failed', { message: String(err) }));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (key: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <section className="compact-section">
      <h3>{t('compact.title')}</h3>
      <p className="muted">{t('compact.help')}</p>

      {overview && (
        <>
          <div className="compact-summary">
            <strong>{t('compact.diskUsage', { bytes: formatBytes(overview.db_bytes) })}</strong>
            <span>{t('compact.total', { flows: overview.total_flows, sites: overview.sites.length })}</span>
            <span>{t('compact.freePages', { bytes: formatBytes(overview.reclaimable_bytes) })}</span>
          </div>
          <div className="compact-actions">
            <button type="button" disabled={busy} onClick={() => void run([])}>
              {t('compact.onlyVacuum')}
            </button>
            <button type="button" disabled={busy} onClick={() => {
              setError(null);
              void refresh().catch((err: unknown) => setError(String(err)));
            }}>
              {t('common.refresh')}
            </button>
          </div>
        </>
      )}

      <h4>{t('compact.targets')}</h4>
      <p className="muted">{t('compact.contentHelp')}</p>
      <div className="compact-actions">
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={t('compact.search')}
          aria-label={t('compact.search')}
        />
        <button type="button" disabled={busy || !overview} onClick={() =>
          setSelected(new Set(overview?.sites.filter((site) => !site.in_scope).map(siteKey) ?? []))
        }>{t('compact.selectOut')}</button>
        <button type="button" disabled={busy || selected.size === 0} onClick={() => setSelected(new Set())}>
          {t('compact.clearSelection')}
        </button>
      </div>

      {overview && visibleSites.length > 0 ? (
        <div className="compact-table-wrap">
          <ResizableTable columns={columns} className="compact-table">
            <thead><tr>
              {[t('compact.target'), t('compact.scope'), t('compact.flows'), t('compact.content')].map((label, index) => (
                <ResizableHeader key={index} label={label} index={index} columns={columns} resizeLabel={t('table.resizeColumn', { column: label })} />
              ))}
            </tr></thead>
            <tbody>
              {visibleSites.map((site) => {
                const key = siteKey(site);
                const label = site.host
                  ? `${site.scheme ?? 'http'}://${site.host}${site.port == null ? '' : `:${site.port}`}`
                  : t('compact.unknown');
                return (
                  <tr key={key}>
                    <td><label><input type="checkbox" disabled={busy} checked={selected.has(key)} onChange={() => toggle(key)} /> {label}</label></td>
                    <td>{site.in_scope ? t('compact.inScope') : t('compact.outOfScope')}</td>
                    <td>{site.flows.toLocaleString()}</td>
                    <td>{formatBytes(site.content_bytes)}</td>
                  </tr>
                );
              })}
            </tbody>
          </ResizableTable>
        </div>
      ) : <p className="muted">{overview ? t('compact.noTargets') : t('compact.loading')}</p>}

      <div className="compact-footer">
        <span>{t('compact.selected', { sites: selectedSites.length, flows: selectedFlows })}</span>
        <button type="button" className="danger" disabled={busy || selectedSites.length === 0} onClick={() => setConfirmDelete(true)}>
          {busy ? t('compact.working') : t('compact.delete')}
        </button>
      </div>

      {result && <p className="muted" role="status">{result}</p>}
      {error && <div className="banner error" role="alert">{error}</div>}

      <ConfirmDialog
        open={confirmDelete}
        title={t('compact.confirmTitle')}
        message={t('compact.confirmMessage', { sites: selectedSites.length, flows: selectedFlows })}
        confirmLabel={t('compact.delete')}
        onConfirm={() => void run(selectedSites)}
        onCancel={() => setConfirmDelete(false)}
      />
    </section>
  );
}

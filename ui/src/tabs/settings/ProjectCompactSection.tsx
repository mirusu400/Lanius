/** Inspect and reclaim project storage without touching scope or settings. */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  compactProject,
  getCompactProgress,
  getCompactOverview,
  getRunningCompact,
  type CompactOverview,
  type CompactProgress,
  type CompactSite,
} from '../../api/client';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { CompactProgressDialog } from './CompactProgressDialog';
import { useT } from '../../i18n';
import { formatBytes } from '../dashboardModel';
import { ResizableFillCell, ResizableFillHeader, ResizableHeader, ResizableTable, useResizableColumns } from '../../components/ResizableColumns';
import { UndoableInput } from '../../components/UndoableText';

const siteKey = (site: CompactSite) => JSON.stringify([site.scheme, site.host, site.port]);

export function ProjectCompactSection() {
  const t = useT();
  const columns = useResizableColumns('lanius.columns.compact', [360, 130, 110, 150]);
  const [overview, setOverview] = useState<CompactOverview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [progress, setProgress] = useState<CompactProgress | null>(null);
  // Following a cleanup this window did not start (it was reloaded, or
  // Settings was reopened), so no POST of ours will report the end.
  const [attached, setAttached] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const refresh = useCallback(async () => {
    setOverview(await getCompactOverview());
  }, []);

  useEffect(() => {
    void refresh().catch((err: unknown) => setError(String(err)));
  }, [refresh]);

  useEffect(() => {
    let active = true;
    void getRunningCompact().then((running) => {
      if (!active || !running.active) return;
      setAttached(true);
      setProgress(running);
      setOperationId(running.operation_id);
      setBusy(true);
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!operationId) return;
    let active = true;
    let pending = false;
    let failures = 0;
    const release = async (message: string | null) => {
      setAttached(false);
      setOperationId(null);
      setBusy(false);
      if (message) setError(message);
      await refresh().catch(() => undefined);
    };
    const poll = async () => {
      if (pending) return;
      pending = true;
      try {
        const snapshot = await getCompactProgress(operationId);
        if (!active) return;
        failures = 0;
        setProgress(snapshot);
        if (attached && !snapshot.active) {
          await release(snapshot.phase === 'failed' ? t('compact.phase.failed') : null);
        }
      } catch {
        // The POST may not have registered yet; its own response reports
        // errors. A followed cleanup has no POST, so if the engine stops
        // knowing about it (it restarted) the shield must not stay forever.
        failures += 1;
        if (active && attached && failures >= 3) await release(t('compact.phase.failed'));
      } finally {
        pending = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 700);
    return () => { active = false; window.clearInterval(timer); };
  }, [operationId, attached, refresh, t]);

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
    const id = crypto.randomUUID();
    setConfirmDelete(false);
    setBusy(true);
    setProgress(null);
    setOperationId(id);
    setError(null);
    setResult(null);
    try {
      const data = await compactProject(sites, id);
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
      setOperationId(null);
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
        <UndoableInput
          value={filter}
          onValueChange={setFilter}
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
              <ResizableFillHeader />
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
                    <ResizableFillCell />
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

      <CompactProgressDialog open={busy} progress={progress} />

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

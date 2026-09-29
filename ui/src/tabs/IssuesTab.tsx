import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  deleteIssue,
  getScannerState,
  listIssues,
  setIssueStatus,
  setPassiveScanner,
  startActiveScan,
  stopScanJob,
} from '../api/client';
import type {
  Issue,
  IssueSeverity,
  IssueStatus,
  IssueSummary,
  ScannerState,
} from '../api/types';
import { useReportBusy } from '../components/busy';
import { rawMsg, renderMessage, useT, type Message } from '../i18n';

const EMPTY_SUMMARY: IssueSummary = {
  total: 0,
  by_severity: { info: 0, low: 0, medium: 0, high: 0, critical: 0 },
  by_status: { open: 0, resolved: 0, false_positive: 0 },
};

const EMPTY_SCANNER: ScannerState = {
  passive_enabled: true,
  passive_checks: [],
  active_checks: [],
  jobs: [],
};

const SEVERITIES: IssueSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

export function IssuesTab() {
  const t = useT();
  const [issues, setIssues] = useState<Issue[]>([]);
  const [summary, setSummary] = useState(EMPTY_SUMMARY);
  const [scanner, setScanner] = useState(EMPTY_SCANNER);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<IssueStatus | ''>('open');
  const [severity, setSeverity] = useState<IssueSeverity | ''>('');
  const [search, setSearch] = useState('');
  const [flowId, setFlowId] = useState('');
  const [selectedChecks, setSelectedChecks] = useState<string[]>([]);
  const [concurrency, setConcurrency] = useState(3);
  const [rate, setRate] = useState(5);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Message | null>(null);
  useReportBusy('issues', loading);

  const refresh = useCallback(async () => {
    try {
      const [issueData, scannerData] = await Promise.all([
        listIssues({ status, severity, search }),
        getScannerState(),
      ]);
      setIssues(issueData.items);
      setSummary(issueData.summary);
      setScanner(scannerData);
      setSelectedId((current) =>
        current && issueData.items.some((issue) => issue.id === current)
          ? current
          : issueData.items[0]?.id ?? null,
      );
    } catch (err) {
      setError(rawMsg((err as Error).message));
    } finally {
      setLoading(false);
    }
  }, [search, severity, status]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!scanner.jobs.some((job) => job.status === 'pending' || job.status === 'running')) return;
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => window.clearInterval(timer);
  }, [refresh, scanner.jobs]);

  const selected = useMemo(
    () => issues.find((issue) => issue.id === selectedId) ?? null,
    [issues, selectedId],
  );

  const changeStatus = async (issue: Issue, next: IssueStatus) => {
    try {
      await setIssueStatus(issue.id, next);
      setError(null);
      await refresh();
    } catch (err) {
      setError(rawMsg((err as Error).message));
    }
  };

  const remove = async (issue: Issue) => {
    try {
      await deleteIssue(issue.id);
      setError(null);
      await refresh();
    } catch (err) {
      setError(rawMsg((err as Error).message));
    }
  };

  const togglePassive = async () => {
    try {
      await setPassiveScanner(!scanner.passive_enabled);
      await refresh();
    } catch (err) {
      setError(rawMsg((err as Error).message));
    }
  };

  const start = async () => {
    if (!flowId.trim()) return;
    try {
      await startActiveScan(flowId.trim(), {
        check_ids: selectedChecks,
        concurrency,
        requests_per_second: rate,
      });
      setError(null);
      await refresh();
    } catch (err) {
      setError(rawMsg((err as Error).message));
    }
  };

  return (
    <div className="issues-tab">
      <div className="scanner-controls">
        <label>
          <input
            type="checkbox"
            checked={scanner.passive_enabled}
            onChange={() => void togglePassive()}
          />
          {t('issues.passive')} ({scanner.passive_checks.length})
        </label>
        <input
          value={flowId}
          onChange={(event) => setFlowId(event.target.value)}
          placeholder={t('issues.flowId')}
          aria-label={t('issues.flowId')}
        />
        <label>
          {t('issues.concurrency')}
          <input
            type="number"
            min={1}
            max={10}
            value={concurrency}
            onChange={(event) => setConcurrency(Number(event.target.value))}
          />
        </label>
        <label>
          {t('issues.rate')}
          <input
            type="number"
            min={0.1}
            max={50}
            step={0.1}
            value={rate}
            onChange={(event) => setRate(Number(event.target.value))}
          />
        </label>
        <button disabled={!flowId.trim() || scanner.active_checks.length === 0} onClick={() => void start()}>
          {t('issues.startActive')}
        </button>
      </div>

      {scanner.active_checks.length > 0 && (
        <div className="scanner-checks">
          {scanner.active_checks.map((check) => (
            <label key={check.id} title={check.description ?? undefined}>
              <input
                type="checkbox"
                checked={selectedChecks.includes(check.id)}
                onChange={() => setSelectedChecks((current) =>
                  current.includes(check.id)
                    ? current.filter((id) => id !== check.id)
                    : [...current, check.id]
                )}
              />
              {check.title}
            </label>
          ))}
          <span className="muted">{t('issues.noChecksMeansAll')}</span>
        </div>
      )}

      {scanner.jobs.length > 0 && (
        <div className="scanner-jobs">
          {scanner.jobs.slice().reverse().slice(0, 5).map((job) => (
            <span key={job.id} className="scanner-job mono">
              {job.id} · {job.status} · {job.completed}/{job.total} · {job.requests} req · {job.issues} issues
              {(job.status === 'pending' || job.status === 'running') && (
                <button onClick={() => void stopScanJob(job.id).then(refresh)}>{t('issues.stop')}</button>
              )}
            </span>
          ))}
        </div>
      )}

      {error && <div className="banner error">{renderMessage(error, t)}</div>}

      <div className="issue-filters">
        <select value={status} onChange={(event) => setStatus(event.target.value as IssueStatus | '')}>
          <option value="">{t('issues.allStatuses')}</option>
          <option value="open">{t('issues.open')}</option>
          <option value="resolved">{t('issues.resolved')}</option>
          <option value="false_positive">{t('issues.falsePositive')}</option>
        </select>
        <select value={severity} onChange={(event) => setSeverity(event.target.value as IssueSeverity | '')}>
          <option value="">{t('issues.allSeverities')}</option>
          {SEVERITIES.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('issues.search')} />
        <span className="issue-counts mono">
          {SEVERITIES.map((value) => `${value} ${summary.by_severity[value]}`).join(' · ')}
        </span>
      </div>

      <div className="issues-body">
        <div className="issues-list">
          {issues.map((issue) => (
            <button
              key={issue.id}
              className={issue.id === selectedId ? 'issue-row selected' : 'issue-row'}
              onClick={() => setSelectedId(issue.id)}
            >
              <span className={`issue-severity severity-${issue.severity}`}>{issue.severity}</span>
              <strong>{issue.title}</strong>
              <span className="muted">{issue.host}{issue.path}</span>
              <span className="muted">×{issue.occurrences}</span>
            </button>
          ))}
          {!loading && issues.length === 0 && <p className="muted pad">{t('issues.none')}</p>}
        </div>
        {selected ? (
          <article className="issue-detail">
            <h2>{selected.title}</h2>
            <div className="issue-meta mono">
              {selected.severity} · {selected.confidence} · {selected.scan_mode} · {selected.plugin_id}.{selected.check_id}
            </div>
            {selected.url && <div className="mono">{selected.url}</div>}
            {selected.parameter && <div>{t('issues.parameter')}: <code>{selected.parameter}</code></div>}
            <h3>{t('issues.detail')}</h3>
            <p className="pre-wrap">{selected.detail}</p>
            {selected.remediation && (
              <><h3>{t('issues.remediation')}</h3><p className="pre-wrap">{selected.remediation}</p></>
            )}
            {selected.evidence && (
              <><h3>{t('issues.evidence')}</h3><pre>{JSON.stringify(selected.evidence, null, 2)}</pre></>
            )}
            <div className="issue-actions">
              <button onClick={() => void changeStatus(selected, 'open')}>{t('issues.open')}</button>
              <button onClick={() => void changeStatus(selected, 'resolved')}>{t('issues.resolved')}</button>
              <button onClick={() => void changeStatus(selected, 'false_positive')}>{t('issues.falsePositive')}</button>
              <button className="danger" onClick={() => void remove(selected)}>{t('common.delete')}</button>
            </div>
          </article>
        ) : (
          <div className="issue-detail muted pad">{t('issues.select')}</div>
        )}
      </div>
    </div>
  );
}

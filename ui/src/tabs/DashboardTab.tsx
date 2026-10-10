import { useCallback, useEffect, useRef, useState } from 'react';

import { getDashboard } from '../api/client';
import type { Dashboard } from '../api/types';
import { connectStream } from '../api/stream';
import { useT } from '../i18n';
import { OpenBrowserButton } from '../components/OpenBrowserButton';
import { useReportBusy } from '../components/busy';
import { DoctorPanel } from './DoctorPanel';
import {
  formatBytes,
  formatDuration,
  formatMillis,
  shortenModeError,
  STATUS_ORDER,
} from './dashboardModel';

/** Live traffic keeps arriving, so refreshes are coalesced into one call. */
const REFRESH_MS = 1000;

export function DashboardTab({
  onOpenTab,
  onOpenMethod,
  onOpenSettings,
  onOpenFuzzerRun,
}: {
  onOpenTab?: (tab: string) => void;
  onOpenMethod?: (method: string) => void;
  onOpenSettings?: (group: 'proxy' | 'browser') => void;
  onOpenFuzzerRun?: (id: string) => void;
}) {
  const t = useT();
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [doctorOpen, setDoctorOpen] = useState(false);
  const pending = useRef(false);

  const [loading, setLoading] = useState(true);
  useReportBusy('dashboard', loading);

  const refresh = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    try {
      setData(await getDashboard());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Recompute on traffic, but no more than once a second: a busy capture
  // would otherwise refetch on every single flow.
  useEffect(() => {
    let timer: number | undefined;
    const dispose = connectStream({
      onState: (state) => { if (state === 'open') void refresh(); },
      onEvent: () => {
        if (timer !== undefined) return;
        timer = window.setTimeout(() => {
          timer = undefined;
          void refresh();
        }, REFRESH_MS);
      },
    });
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      dispose();
    };
  }, [refresh]);

  if (!data) return <div className="dash">
    <header className="dash-head">
      <div><h2>{t('dash.title')}</h2><p className="dash-sub">{t('dash.subtitle')}</p></div>
      <button type="button" onClick={() => setDoctorOpen((open) => !open)} aria-expanded={doctorOpen}>{t('doctor.title')}</button>
    </header>
    {error && <div className="banner error" role="alert">
      <p>{t('doctor.engineError', { message: error })}</p>
      <button type="button" onClick={() => void refresh()}>{t('common.refresh')}</button>
    </div>}
    {loading && <p className="muted">{t('doctor.checking')}</p>}
    {doctorOpen && <DoctorPanel onOpenSettings={onOpenSettings} />}
  </div>;

  const address = `${data.proxy.host}:${data.proxy.port}`;
  const totalStatus = Object.values(data.status_groups).reduce((a, b) => a + b, 0);
  const failures = (data.status_groups['4xx'] ?? 0) + (data.status_groups['5xx'] ?? 0);

  const downModes = (data.modes ?? []).filter((m) => !m.running);
  // Local capture reports itself as running while it waits for approval,
  // so an unapproved extension is a separate signal from a dead mode.
  const capture = data.local_capture;
  const captureBlocked =
    capture && !capture.approved && (data.modes ?? []).some((m) => m.spec.startsWith('local'));
  const activeFuzzerRuns = (data.fuzzer_runs ?? []).filter((run) => run.status === 'pending' || run.status === 'running');

  return (
    <div className="dash">
      <header className="dash-head">
        <div>
          <h2>{t('dash.title')}</h2>
          <p className="dash-sub">{t('dash.subtitle')}</p>
          <div className="dash-actions">
            <OpenBrowserButton />
            <button type="button" onClick={() => setDoctorOpen((open) => !open)} aria-expanded={doctorOpen}>
              {t('doctor.title')}
            </button>
          </div>
        </div>
        <div className="dash-engine">
          <span className={data.proxy.running ? 'pill ok' : 'pill bad'}>
            {data.proxy.running
              ? t('dash.proxyRunning', { address })
              : t('dash.proxyStopped')}
          </span>
          <span className={data.intercept_enabled ? 'pill warn' : 'pill'}>
            {data.intercept_enabled ? t('dash.interceptOn') : t('dash.interceptOff')}
          </span>
          {data.paused > 0 && (
            <span className="pill warn">
              {t('dash.pausedFlows', { count: String(data.paused) })}
            </span>
          )}
        </div>
      </header>

      {error && <div className="banner error" role="alert">
        <p>{t('doctor.dashboardStale', { message: error })}</p>
        <button type="button" onClick={() => void refresh()}>{t('common.refresh')}</button>
      </div>}
      {doctorOpen && <DoctorPanel onOpenSettings={onOpenSettings} />}

      {activeFuzzerRuns.length > 0 && <section className="dash-panel dash-fuzzer-runs">
        <h3>{t('dash.fuzzerRuns')}</h3>
        {activeFuzzerRuns.map((run) => <button type="button" key={run.id}
          onClick={() => onOpenFuzzerRun?.(run.id)}>
          <span className="mono">{run.url}</span>
          <span>{run.completed}/{run.total}</span>
        </button>)}
      </section>}

      {(downModes.length > 0 || captureBlocked) && (
        <section className="dash-alerts">
          {captureBlocked && (
            <div className="dash-alert">
              <strong>
                {capture.detail === 'not installed' ||
                capture.supported === false
                  ? t('dash.captureUnavailable', {
                      detail: capture.detail ?? '',
                    })
                  : t('dash.captureWaiting')}
              </strong>
              <span>{t('dash.captureWaitingHelp')}</span>
            </div>
          )}
          {downModes.map((mode) => (
            <div className="dash-alert" key={mode.spec}>
              <strong>{t('dash.modeDown', { spec: mode.spec })}</strong>
              {mode.error && (
                <span className="mono" title={mode.error}>
                  {shortenModeError(mode.error)}
                </span>
              )}
            </div>
          ))}
        </section>
      )}

      {data.flows === 0 ? (
        <div className="dash-empty">
          <p>{t('dash.empty')}</p>
          <p className="dash-sub">{t('dash.emptyHelp', { address })}</p>
        </div>
      ) : (
        <>
          <section className="dash-cards">
            <Card label={t('dash.flows')} value={String(data.flows)}>
              {data.pending > 0 && (
                <span className="dash-note">
                  {data.pending} {t('dash.pending')}
                </span>
              )}
            </Card>
            <Card label={t('dash.hosts')} value={String(data.hosts)} />
            <Card label={t('dash.traffic')} value={formatBytes(data.bytes)} />
            <Card
              label={t('dash.avgDuration')}
              value={formatMillis(data.avg_duration_ms)}
            >
              {failures > 0 && (
                <span className="dash-note bad">
                  {failures} {t('dash.failures')}
                </span>
              )}
            </Card>
            <Card
              label={t('dash.recent', {
                seconds: String(Math.round(data.recent_window_seconds)),
              })}
              value={String(data.recent_flows)}
            >
              {data.span_seconds > 0 && (
                <span className="dash-note">
                  {t('dash.captureSpan', {
                    duration: formatDuration(data.span_seconds),
                  })}
                </span>
              )}
            </Card>
          </section>

          <section className="dash-grid">
            <Panel title={t('dash.statusTitle')}>
              {totalStatus === 0 ? (
                <p className="dash-sub">{t('dash.noStatus')}</p>
              ) : (
                <ul className="dash-bars">
                  {STATUS_ORDER.filter((k) => data.status_groups[k]).map((key) => {
                    const count = data.status_groups[key];
                    return (
                      <li key={key}>
                        <span className="dash-bar-label">
                          {t(`dash.status${key}` as 'dash.status2xx')}
                        </span>
                        <span className="dash-bar-track">
                          <span
                            className={`dash-bar s${key}`}
                            style={{ width: `${(count / totalStatus) * 100}%` }}
                          />
                        </span>
                        <span className="dash-bar-value">{count}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Panel>

            <Panel title={t('dash.methodsTitle')}>
              <ul className="dash-chips">
                {data.methods.map((m) => (
                  <li key={m.method}>
                    <button
                      type="button"
                      className="dash-chip"
                      aria-label={`${m.method} ${m.count}`}
                      onClick={() => onOpenMethod?.(m.method)}
                    >
                      <span className="dash-chip-name">{m.method}</span>
                      <span className="dash-chip-count">{m.count}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </Panel>

            <Panel title={t('dash.hostsTitle')} wide>
              <table className="dash-table">
                <tbody>
                  {data.top_hosts.map((h) => (
                    <tr
                      key={h.host}
                      onClick={() => onOpenTab?.('Target')}
                      className={onOpenTab ? 'clickable' : undefined}
                    >
                      <td className="dash-host">{h.host}</td>
                      <td className="dash-num">{h.flows}</td>
                      <td className="dash-num dim">{formatBytes(h.bytes)}</td>
                      <td className="dash-num">
                        {h.errors > 0 && (
                          <span className="bad">
                            {t('dash.errorsShort', { count: String(h.errors) })}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          </section>
        </>
      )}
    </div>
  );
}

function Card({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="dash-card">
      <span className="dash-card-label">{label}</span>
      <strong className="dash-card-value">{value}</strong>
      {children}
    </div>
  );
}

function Panel({
  title,
  children,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <section className={wide ? 'dash-panel wide' : 'dash-panel'}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';

import { getDashboard } from '../api/client';
import type { Dashboard } from '../api/types';
import { connectStream } from '../api/stream';
import { useT } from '../i18n';
import { formatBytes, formatDuration, formatMillis, STATUS_ORDER } from './dashboardModel';

/** Live traffic keeps arriving, so refreshes are coalesced into one call. */
const REFRESH_MS = 1000;

export function DashboardTab({ onOpenTab }: { onOpenTab?: (tab: string) => void }) {
  const t = useT();
  const [data, setData] = useState<Dashboard | null>(null);
  const pending = useRef(false);

  const refresh = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    try {
      setData(await getDashboard());
    } catch {
      // The engine may still be starting; the next tick retries.
    } finally {
      pending.current = false;
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

  if (!data) return <div className="dash" />;

  const address = `${data.proxy.host}:${data.proxy.port}`;
  const totalStatus = Object.values(data.status_groups).reduce((a, b) => a + b, 0);
  const failures = (data.status_groups['4xx'] ?? 0) + (data.status_groups['5xx'] ?? 0);

  return (
    <div className="dash">
      <header className="dash-head">
        <div>
          <h2>{t('dash.title')}</h2>
          <p className="dash-sub">{t('dash.subtitle')}</p>
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
                    <span className="dash-chip-name">{m.method}</span>
                    <span className="dash-chip-count">{m.count}</span>
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

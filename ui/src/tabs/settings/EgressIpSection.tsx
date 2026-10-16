import { useEffect, useState } from 'react';

import { getEgressIpState, setEgressIpState } from '../../api/client';
import type { EgressIpObservation, EgressIpState } from '../../api/types';
import { Dialog } from '../../components/Dialog';
import { UndoableInput } from '../../components/UndoableText';
import { useT } from '../../i18n';

const DEFAULT_IPV4_URL = 'https://api.ipify.org';
const DEFAULT_IPV6_URL = 'https://api6.ipify.org';
type Interval = 60 | 180 | 300;

function validHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function observed(item: EgressIpObservation | null, never: string): string {
  if (!item) return never;
  return `${item.ip} · ${new Date(item.last_seen_at * 1000).toLocaleString()}`;
}

export function EgressIpSection() {
  const t = useT();
  const [state, setState] = useState<EgressIpState | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [interval, setIntervalValue] = useState<Interval>(180);
  const [ipv4Url, setIpv4Url] = useState(DEFAULT_IPV4_URL);
  const [ipv6Url, setIpv6Url] = useState(DEFAULT_IPV6_URL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [history, setHistory] = useState<EgressIpObservation[]>([]);

  const load = (next: EgressIpState, replaceDraft: boolean) => {
    // A UI can briefly outlive an older engine during a desktop restart.
    // Fill absent fields instead of taking Settings down on that mismatch.
    const normalized: EgressIpState = {
      enabled: Boolean(next?.enabled),
      interval_seconds: [60, 180, 300].includes(next?.interval_seconds)
        ? next.interval_seconds : 180,
      ipv4_url: typeof next?.ipv4_url === 'string' ? next.ipv4_url : DEFAULT_IPV4_URL,
      ipv6_url: typeof next?.ipv6_url === 'string' ? next.ipv6_url : DEFAULT_IPV6_URL,
      blocked_by_lockdown: Boolean(next?.blocked_by_lockdown),
      last_checked_at: next?.last_checked_at ?? null,
      last_success_at: next?.last_success_at ?? null,
      errors: next?.errors ?? { ipv4: null, ipv6: null },
      current: next?.current ?? { ipv4: null, ipv6: null },
      history: next?.history ?? [],
    };
    setState(normalized);
    if (!replaceDraft) return;
    setEnabled(normalized.enabled);
    setIntervalValue(normalized.interval_seconds);
    setIpv4Url(normalized.ipv4_url);
    setIpv6Url(normalized.ipv6_url);
  };

  const refresh = (replaceDraft = false) => getEgressIpState()
    .then((next) => load(next, replaceDraft))
    .catch((err: Error) => setError(err.message));

  useEffect(() => {
    void refresh(true);
  }, []);

  const changed = state !== null && (
    enabled !== state.enabled
    || interval !== state.interval_seconds
    || ipv4Url.trim() !== state.ipv4_url
    || ipv6Url.trim() !== state.ipv6_url
  );
  const valid = validHttpsUrl(ipv4Url.trim()) && validHttpsUrl(ipv6Url.trim());

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await setEgressIpState({
        enabled,
        interval_seconds: interval,
        ipv4_url: ipv4Url.trim(),
        ipv6_url: ipv6Url.trim(),
      });
      load(next, true);
      if (next.enabled && !next.blocked_by_lockdown) {
        window.setTimeout(() => void refresh(false), 1000);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const refreshHistory = async () => {
    setHistoryBusy(true);
    setHistoryError(null);
    try {
      const next = await getEgressIpState(1000);
      setHistory(next.history ?? []);
    } catch (err) {
      setHistoryError((err as Error).message);
    } finally {
      setHistoryBusy(false);
    }
  };

  const openHistory = () => {
    setHistoryOpen(true);
    void refreshHistory();
  };

  return <section>
    <h3>{t('egressIp.section')}</h3>
    <p className="muted">{t('egressIp.help')}</p>
    <div className="settings-row">
      <label><input type="checkbox" checked={enabled} disabled={state === null || busy}
        onChange={(event) => setEnabled(event.target.checked)} />{' '}
        {t('egressIp.enabled')}</label>
    </div>
    <p className="muted">{t('egressIp.privacy')}</p>

    <div className="settings-row">
      <label htmlFor="egress-ip-interval">{t('egressIp.interval')}</label>
      <select id="egress-ip-interval" value={interval} disabled={state === null || busy}
        onChange={(event) => setIntervalValue(Number(event.target.value) as Interval)}>
        <option value={60}>{t('egressIp.oneMinute')}</option>
        <option value={180}>{t('egressIp.threeMinutes')}</option>
        <option value={300}>{t('egressIp.fiveMinutes')}</option>
      </select>
    </div>

    <div className="settings-row">
      <label htmlFor="egress-ip-v4">{t('egressIp.ipv4Url')}</label>
      <UndoableInput id="egress-ip-v4" className="mono upstream-url" type="url"
        value={ipv4Url} disabled={state === null || busy} historyKey="egress-ip-v4"
        onValueChange={setIpv4Url} />
    </div>
    <div className="settings-row">
      <label htmlFor="egress-ip-v6">{t('egressIp.ipv6Url')}</label>
      <UndoableInput id="egress-ip-v6" className="mono upstream-url" type="url"
        value={ipv6Url} disabled={state === null || busy} historyKey="egress-ip-v6"
        onValueChange={setIpv6Url} />
    </div>
    <p className="muted">{t('egressIp.endpointHelp')}</p>

    <div className="settings-row">
      <button type="button" disabled={state === null || busy || !changed || !valid}
        onClick={() => void apply()}>{t('egressIp.apply')}</button>
      <button type="button" disabled={busy}
        onClick={() => { setIpv4Url(DEFAULT_IPV4_URL); setIpv6Url(DEFAULT_IPV6_URL); }}>
        {t('egressIp.defaults')}
      </button>
      <button type="button" disabled={busy || state === null}
        onClick={() => void refresh(false)}>{t('common.refresh')}</button>
    </div>

    {state?.blocked_by_lockdown && <p className="lockdown-active">{t('egressIp.lockdown')}</p>}
    {state && <div>
      <p><strong>{t('egressIp.currentIpv4')}:</strong>{' '}
        <span className="mono">{observed(state.current.ipv4, t('egressIp.never'))}</span></p>
      <p><strong>{t('egressIp.currentIpv6')}:</strong>{' '}
        <span className="mono">{observed(state.current.ipv6, t('egressIp.never'))}</span></p>
      {state.errors.ipv4 && <p className="muted">IPv4: {state.errors.ipv4}</p>}
      {state.errors.ipv6 && <p className="muted">IPv6: {state.errors.ipv6}</p>}
      <button type="button" disabled={historyBusy} onClick={openHistory}>
        {t('egressIp.viewHistory')}
      </button>
    </div>}
    {error && <div className="banner error" role="alert">{error}</div>}

    <Dialog
      open={historyOpen}
      title={t('egressIp.historyTitle')}
      onClose={() => setHistoryOpen(false)}
      className="egress-ip-history-dialog"
      footer={<>
        <span className="muted">
          {t('egressIp.historyCount', { count: history.length.toLocaleString() })}
        </span>
        <span className="spacer" />
        <button type="button" disabled={historyBusy} onClick={() => void refreshHistory()}>
          {t('common.refresh')}
        </button>
        <button type="button" onClick={() => setHistoryOpen(false)}>{t('common.close')}</button>
      </>}
    >
      <p className="muted egress-ip-history-help">{t('egressIp.historyHelp')}</p>
      {historyError && <div className="banner error" role="alert">{historyError}</div>}
      <div className="egress-ip-history-table-wrap" aria-busy={historyBusy}>
        <table className="egress-ip-history-table">
          <thead><tr>
            <th>{t('egressIp.family')}</th>
            <th>{t('egressIp.address')}</th>
            <th>{t('egressIp.firstSeen')}</th>
            <th>{t('egressIp.lastSeen')}</th>
            <th>{t('egressIp.checks')}</th>
            <th>{t('egressIp.observer')}</th>
          </tr></thead>
          <tbody>
            {history.map((item) => <tr key={item.id}>
              <td>IPv{item.family}</td>
              <td className="mono">{item.ip}</td>
              <td>{new Date(item.first_seen_at * 1000).toLocaleString()}</td>
              <td>{new Date(item.last_seen_at * 1000).toLocaleString()}</td>
              <td>{item.check_count.toLocaleString()}</td>
              <td className="mono" title={item.observer_url}>{item.observer_url}</td>
            </tr>)}
            {!historyBusy && history.length === 0 && <tr>
              <td colSpan={6} className="empty">{t('egressIp.historyEmpty')}</td>
            </tr>}
            {historyBusy && history.length === 0 && <tr>
              <td colSpan={6} className="empty">{t('common.loading')}…</td>
            </tr>}
          </tbody>
        </table>
      </div>
    </Dialog>
  </section>;
}

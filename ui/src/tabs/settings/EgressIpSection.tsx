import { useEffect, useState } from 'react';

import { getEgressIpState, setEgressIpState, setEgressPin } from '../../api/client';
import type { EgressIpObservation, EgressIpState, EgressPinState } from '../../api/types';
import { Dialog } from '../../components/Dialog';
import { UndoableInput } from '../../components/UndoableText';
import { useT } from '../../i18n';
import { useSettingsToast } from '../../components/useSettingsToast';

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

const NO_PIN: EgressPinState = {
  enabled: false,
  ipv4: null,
  ipv6: null,
  allowed: true,
  reason: null,
  mismatch: { ipv4: null, ipv6: null },
  candidates: { ipv4: null, ipv6: null },
};

function pinnedIps(pin: { ipv4: string | null; ipv6: string | null }): string {
  return [pin.ipv4, pin.ipv6].filter(Boolean).join(', ');
}

export function EgressIpSection() {
  const t = useT();
  const saved = useSettingsToast('egressIp.section');
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
  const [pinConfirmOpen, setPinConfirmOpen] = useState(false);

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
      poll_seconds: next?.poll_seconds,
      pin: { ...NO_PIN, ...(next?.pin ?? {}) },
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

  const pin = state?.pin ?? NO_PIN;
  // The pin status changes on its own (observer rounds, network changes).
  useEffect(() => {
    if (!pin.enabled) return undefined;
    const timer = window.setInterval(() => void refresh(false), 5000);
    return () => window.clearInterval(timer);
  }, [pin.enabled]);

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
      saved(next.enabled && next.blocked_by_lockdown ? { detail: t('egressIp.lockdown') } : {});
      if (next.enabled && !next.blocked_by_lockdown) {
        window.setTimeout(() => void refresh(false), 1000);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const candidates = pinnedIps(pin.candidates);
  const pinUnavailable = state === null || busy || state.blocked_by_lockdown
    || !state.enabled || !candidates;

  const applyPin = async (enable: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const next = await setEgressPin(enable
        ? { enabled: true, ipv4: pin.candidates.ipv4, ipv6: pin.candidates.ipv6 }
        : { enabled: false });
      load(next, false);
      saved({ detail: t(enable ? 'egressIp.pinApplied' : 'egressIp.unpinApplied') });
      if (enable) window.setTimeout(() => void refresh(false), 1500);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setPinConfirmOpen(false);
    }
  };

  const pinStatus = () => {
    if (pin.reason === 'lockdown') return t('egressIp.pinBlockedLockdown');
    if (pin.reason === 'mismatch') {
      return t('egressIp.pinBlockedMismatch', { ip: pinnedIps(pin.mismatch) });
    }
    if (pin.reason === 'unverified') return t('egressIp.pinBlockedUnverified');
    return t('egressIp.pinAllowed');
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
      <label><input type="checkbox" checked={enabled}
        disabled={state === null || busy || (pin.enabled && enabled)}
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
    {pin.enabled && <p className="muted">{t('egressIp.pinPolling')}</p>}

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

    <div className="egress-ip-pin">
      <p className="muted">{t('egressIp.pinHelp')}</p>
      {pin.enabled ? <>
        <p><strong>{t('egressIp.pinned')}:</strong>{' '}
          <span className="mono">{pinnedIps(pin)}</span></p>
        <p role="status" className={pin.allowed ? undefined : 'lockdown-active'}>{pinStatus()}</p>
        <div className="settings-row">
          <button type="button" disabled={busy} onClick={() => void applyPin(false)}>
            {t('egressIp.unpin')}
          </button>
        </div>
      </> : <>
        <div className="settings-row">
          <button type="button" disabled={pinUnavailable} onClick={() => setPinConfirmOpen(true)}>
            {t('egressIp.pinButton')}
          </button>
        </div>
        {state?.blocked_by_lockdown
          ? <p className="muted">{t('egressIp.pinUnavailableLockdown')}</p>
          : state && (!state.enabled || !candidates)
            && <p className="muted">{t('egressIp.pinNeedsObservation')}</p>}
      </>}
    </div>
    {error && <div className="banner error" role="alert">{error}</div>}

    <Dialog
      open={pinConfirmOpen}
      title={t('egressIp.pinConfirmTitle')}
      onClose={() => setPinConfirmOpen(false)}
      footer={<>
        <span className="spacer" />
        <button type="button" disabled={busy} onClick={() => setPinConfirmOpen(false)}>
          {t('common.cancel')}
        </button>
        <button type="button" className="primary" disabled={busy || !candidates}
          onClick={() => void applyPin(true)}>
          {t('egressIp.pinYes')}
        </button>
      </>}
    >
      <p>{t('egressIp.pinConfirm', { ips: candidates })}</p>
      <p className="muted">{t('egressIp.pinConfirmDetail')}</p>
    </Dialog>

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

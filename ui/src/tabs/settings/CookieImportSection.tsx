/** Copy one browser profile's cookies into a Lanius-owned browser profile. */
import { useEffect, useState } from 'react';

import {
  createCookieExtensionTicket, downloadCookieExporter, getCookieExtensionStatus,
  getCookieImportState, importBrowserCookies,
} from '../../api/client';
import type { CookieImportResult, CookieImportState } from '../../api/types';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useToast } from '../../components/Toast';
import { useT } from '../../i18n';

export function CookieImportSection() {
  const t = useT();
  const { showToast } = useToast();
  const [state, setState] = useState<CookieImportState | null>(null);
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<CookieImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ticketCode, setTicketCode] = useState<string | null>(null);
  const [ticketBusy, setTicketBusy] = useState(false);
  const [ticketPhase, setTicketPhase] = useState<'waiting' | 'importing'>('waiting');

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await getCookieImportState();
      setState(next);
      setSource((current) => next.profiles.some((profile) => profile.id === current)
        ? current : next.profiles[0]?.id ?? '');
      setTarget((current) => next.targets.some((browser) => browser.id === current)
        ? current : next.targets.find((browser) => browser.available)?.id ?? '');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void getCookieImportState().then((next) => {
      setState(next);
      setSource(next.profiles[0]?.id ?? '');
      setTarget(next.targets.find((browser) => browser.available)?.id ?? '');
    }).catch((cause) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => setLoading(false));
  }, []);

  const selected = state?.profiles.find((profile) => profile.id === source);
  const destination = state?.targets.find((browser) => browser.id === target);
  const canTarget = Boolean(destination?.available && destination.ready && !destination.open &&
    !loading && !importing && !ticketCode && !ticketBusy);
  const canImport = Boolean(canTarget && selected);

  useEffect(() => {
    if (!ticketCode) return;
    let active = true;
    const poll = async () => {
      try {
        const status = await getCookieExtensionStatus();
        if (!active) return;
        if (status.phase === 'importing') setTicketPhase('importing');
        if (status.phase === 'done' && status.result) {
          setResult(status.result);
          setTicketCode(null);
          showToast({ message: t('browser.cookieImportDone', {
            count: String(status.result.imported), browser: destination?.name ?? '',
          }), tone: 'success', category: 'browser' });
        } else if (status.phase === 'error' || status.phase === 'expired') {
          setError(status.error ?? t('browser.cookieImportTicketExpired'));
          setTicketCode(null);
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    const timer = window.setInterval(() => { void poll(); }, 1000);
    return () => { active = false; window.clearInterval(timer); };
  }, [ticketCode, destination?.name, showToast, t]);

  const downloadExtension = async () => {
    setError(null);
    try {
      const blob = await downloadCookieExporter();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'lanius-cookie-transfer.zip';
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const createTicket = async () => {
    if (!canTarget) return;
    setTicketBusy(true);
    setError(null);
    setResult(null);
    try {
      const ticket = await createCookieExtensionTicket(target);
      setTicketCode(ticket.code);
      setTicketPhase('waiting');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setTicketBusy(false);
    }
  };

  const startImport = async () => {
    setConfirm(false);
    if (!canImport) return;
    setImporting(true);
    setError(null);
    setResult(null);
    try {
      const next = await importBrowserCookies(source, target);
      setResult(next);
      showToast({ message: t('browser.cookieImportDone', {
        count: String(next.imported), browser: destination?.name ?? '',
      }),
        tone: 'success', category: 'browser' });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setImporting(false);
    }
  };

  return <>
    <section>
      <h3>{t('browser.cookieImportSection')}</h3>
      <p className="muted">{t('browser.cookieImportHelp')}</p>
      {loading && !state && <p className="muted" role="status">{t('common.loading')}</p>}
      {state && state.profiles.length === 0 &&
        <div className="banner warn">{t('browser.cookieImportNoSource')}</div>}
      {state && !state.targets.some((browser) => browser.available) &&
        <div className="banner warn">{t('browser.cookieImportNoTarget')}</div>}
      {destination && !destination.ready && destination.available &&
        <div className="banner warn">{t('browser.cookieImportTargetNotReady', { browser: destination.name })}</div>}
      {destination?.open &&
        <div className="banner warn">{t('browser.cookieImportTargetOpen', { browser: destination.name })}</div>}
      {state && <div className="settings-row">
        <label htmlFor="cookie-import-target">{t('browser.cookieImportTarget')}</label>
        <select id="cookie-import-target" value={target} disabled={importing || Boolean(ticketCode)}
          onChange={(event) => { setTarget(event.target.value); setResult(null); }}>
          {state.targets.map((browser) => <option key={browser.id} value={browser.id}
            disabled={!browser.available}>
            {browser.name}
          </option>)}
        </select>
      </div>}
      {state && state.profiles.length > 0 && <>
        <div className="settings-row">
          <label htmlFor="cookie-import-source">{t('browser.cookieImportSource')}</label>
          <select id="cookie-import-source" value={source} disabled={importing}
            onChange={(event) => { setSource(event.target.value); setResult(null); }}>
            {state.profiles.map((profile) => <option key={profile.id} value={profile.id}>
              {profile.name} ({profile.cookie_count})
            </option>)}
          </select>
          <button type="button" disabled={loading || importing} onClick={() => void refresh()}>
            {t('browser.cookieImportRefresh')}
          </button>
          <button type="button" disabled={!canImport} onClick={() => setConfirm(true)}>
            {importing ? t('browser.cookieImportRunning') : t('browser.cookieImportButton')}
          </button>
        </div>
        <p className="muted">{t('browser.cookieImportLimit')}</p>
      </>}
      <h4>{t('browser.cookieImportExtensionTitle')}</h4>
      <p className="muted">{t('browser.cookieImportExtensionHelp')}</p>
      <div className="settings-row">
        <button type="button" onClick={() => void downloadExtension()}>
          {t('browser.cookieImportExtensionDownload')}
        </button>
        <button type="button" disabled={!canTarget} onClick={() => void createTicket()}>
          {t('browser.cookieImportExtensionPair')}
        </button>
      </div>
      {ticketCode && <div className="banner info" role="status">
        <p>{t(ticketPhase === 'importing' ? 'browser.cookieImportExtensionRunning'
          : 'browser.cookieImportExtensionCode')}</p>
        <code>{ticketCode}</code>
      </div>}
      {result && <div className="banner info" role="status">
        {t('browser.cookieImportResult', {
          imported: String(result.imported), partitioned: String(result.partitioned),
          expired: String(result.expired), unsupported: String(result.unsupported),
          protected: String(result.protected),
          session: String(result.session_extended),
        })}
      </div>}
      {error && <div className="banner error" role="alert">
        {t('browser.cookieImportFailed', { message: error })}
      </div>}
    </section>
    <ConfirmDialog
      open={confirm}
      title={t('browser.cookieImportSection')}
      message={t('browser.cookieImportConfirm', {
        profile: selected?.name ?? '', browser: destination?.name ?? '',
        count: String(selected?.cookie_count ?? 0),
      })}
      confirmLabel={t('browser.cookieImportButton')}
      onCancel={() => setConfirm(false)}
      onConfirm={() => { void startImport(); }}
    />
  </>;
}

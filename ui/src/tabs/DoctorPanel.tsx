import { useCallback, useEffect, useState } from 'react';

import { getBrowserState, getCaInfo, getDashboard, openBrowser, type CaInfo } from '../api/client';
import type { BrowserState, Dashboard } from '../api/types';
import { useT } from '../i18n';

type Check<T> = { value: T | null; error: string | null };
type Results = {
  dashboard: Check<Dashboard>;
  browser: Check<BrowserState>;
  ca: Check<CaInfo>;
};

async function check<T>(load: () => Promise<T>): Promise<Check<T>> {
  try {
    return { value: await load(), error: null };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Local configuration checks only. Sending a test request would be product egress. */
export function DoctorPanel({ onOpenSettings }: {
  onOpenSettings?: (group: 'proxy' | 'browser') => void;
}) {
  const t = useT();
  const [results, setResults] = useState<Results | null>(null);
  const [busy, setBusy] = useState(false);
  const [browserBusy, setBrowserBusy] = useState(false);
  const [browserError, setBrowserError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setBusy(true);
    const [dashboard, browser, ca] = await Promise.all([
      check(getDashboard), check(getBrowserState), check(getCaInfo),
    ]);
    setResults({ dashboard, browser, ca });
    setBusy(false);
  }, []);

  useEffect(() => {
    // Paint the panel before starting its three independent checks.
    const timer = window.setTimeout(() => { void run(); }, 0);
    return () => window.clearTimeout(timer);
  }, [run]);

  const launchBrowser = async () => {
    setBrowserBusy(true);
    setBrowserError(null);
    try {
      await openBrowser();
      await run();
    } catch (error) {
      setBrowserError(error instanceof Error ? error.message : String(error));
    } finally {
      setBrowserBusy(false);
    }
  };

  const dashboard = results?.dashboard.value;
  const browser = results?.browser.value;
  const ca = results?.ca.value;
  const capture = dashboard?.local_capture;
  const localMode = dashboard?.modes?.find((mode) => mode.spec.startsWith('local'));
  const captureConfigured = Boolean(localMode || (capture?.spec !== undefined && capture.spec !== null));
  const downModes = dashboard?.modes?.filter((mode) => !mode.running) ?? [];
  const address = dashboard ? `${dashboard.proxy.host}:${dashboard.proxy.port}` : null;
  const systemTrust = ca?.system_trust;
  const caState = results?.ca.error || !ca?.available.pem || systemTrust?.status === 'invalid' ? 'bad'
    : systemTrust?.status === 'trusted' ? 'ok'
      : systemTrust?.status === 'not_trusted' ? 'warn'
        : systemTrust?.platform === 'Windows' ? 'neutral'
          : browser?.available && browser.ca_trusted ? 'ok' : 'neutral';
  const caDetail = results?.ca.error ? t('doctor.checkError', { message: results.ca.error })
    : !ca?.available.pem ? t('doctor.caMissing')
      : systemTrust?.status === 'invalid' ? t('doctor.caInvalid', { message: systemTrust.detail ?? '' })
        : systemTrust?.status === 'trusted' ? t('doctor.caWindowsTrusted')
          : systemTrust?.status === 'not_trusted' ? t('doctor.caWindowsUntrusted')
            : systemTrust?.platform === 'Windows' ? t('doctor.caWindowsUnknown', { message: systemTrust.detail ?? '' })
              : browser?.available && browser.ca_trusted ? t('doctor.caReady') : t('doctor.caManual');

  return (
    <section className="doctor" aria-label={t('doctor.title')}>
      <div className="doctor-head">
        <div>
          <h3>{t('doctor.title')}</h3>
          <p className="muted">{t('doctor.scope')}</p>
        </div>
        <button type="button" onClick={() => void run()} disabled={busy}>
          {busy ? t('doctor.checking') : t('doctor.runAgain')}
        </button>
      </div>

      {!results ? <p className="muted">{t('doctor.checking')}</p> : (
        <div className="doctor-checks">
          <CheckRow
            title={t('doctor.engine')}
            state={dashboard ? 'ok' : 'bad'}
            detail={dashboard ? t('doctor.engineOk') : t('doctor.engineError', { message: results.dashboard.error ?? '' })}
          />
          {dashboard && <CheckRow
            title={t('doctor.listener')}
            state={dashboard.proxy.running ? 'ok' : 'bad'}
            detail={dashboard.proxy.running
              ? t('doctor.listenerOk', { address: address ?? '' })
              : t('doctor.listenerError')}
            action={onOpenSettings && <button type="button" onClick={() => onOpenSettings('proxy')}>{t('doctor.proxySettings')}</button>}
          />}
          {downModes.length > 0 && <CheckRow
            title={t('doctor.otherModes')}
            state="bad"
            detail={downModes.map((mode) => `${mode.spec}: ${mode.error || t('doctor.modeNotRunning')}`).join('; ')}
            action={onOpenSettings && <button type="button" onClick={() => onOpenSettings('proxy')}>{t('doctor.proxySettings')}</button>}
          />}
          <CheckRow
            title={t('doctor.browser')}
            state={results.browser.error ? 'bad' : browser?.available ? 'ok' : 'warn'}
            detail={results.browser.error
              ? t('doctor.checkError', { message: results.browser.error })
              : browser?.available ? t('doctor.browserOk', { name: browser.name ?? '' }) : t('doctor.browserUnavailable')}
            action={browser?.available
              ? <button type="button" disabled={browserBusy || !dashboard?.proxy.running} onClick={() => void launchBrowser()}>{t('browser.open')}</button>
              : onOpenSettings && <button type="button" onClick={() => onOpenSettings('browser')}>{t('doctor.browserSettings')}</button>}
          />
          <CheckRow
            title={t('doctor.certificate')}
            state={caState}
            detail={caDetail}
            label={caState === 'neutral' ? t('doctor.state.unverified') : undefined}
            action={onOpenSettings && <button type="button" onClick={() => onOpenSettings('browser')}>{t('doctor.browserSettings')}</button>}
          />
          {dashboard && <CheckRow
            title={t('doctor.systemCapture')}
            state={!captureConfigured ? 'neutral' : capture?.restart_required || !localMode?.running || !capture?.supported || !capture.approved ? 'warn' : 'ok'}
            detail={!captureConfigured ? t('doctor.systemCaptureOff')
              : capture?.restart_required ? t('capture.restartNeeded')
                : !localMode?.running ? t('doctor.systemCaptureError', { message: localMode?.error ?? t('doctor.modeNotRunning') })
                  : !capture?.supported ? t('doctor.systemCaptureError', { message: capture?.detail ?? '' })
                    : !capture.approved ? t('dash.captureWaitingHelp') : t('doctor.systemCaptureOk')}
            action={onOpenSettings && <button type="button" onClick={() => onOpenSettings('proxy')}>{t('doctor.proxySettings')}</button>}
          />}
          {dashboard && <CheckRow
            title={t('doctor.traffic')}
            state={dashboard.flows > 0 ? 'ok' : 'neutral'}
            detail={dashboard.flows > 0 ? t('doctor.trafficOk', { count: String(dashboard.flows) }) : t('doctor.trafficEmpty')}
          />}
        </div>
      )}
      {browserError && <div className="banner error" role="alert">{t('browser.failed', { message: browserError })}</div>}
    </section>
  );
}

function CheckRow({ title, state, detail, action, label }: {
  title: string;
  state: 'ok' | 'warn' | 'bad' | 'neutral';
  detail: string;
  action?: React.ReactNode;
  label?: string;
}) {
  const t = useT();
  return <div className="doctor-check">
    <span className={`doctor-state ${state}`} aria-hidden="true" />
    <div><strong>{title}</strong> <span className={`doctor-label ${state}`}>{label ?? t(`doctor.state.${state}`)}</span><p>{detail}</p></div>
    {action && <div className="doctor-action">{action}</div>}
  </div>;
}

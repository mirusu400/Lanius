import { useCallback, useEffect, useState } from 'react';

import { useT, type TranslationKey } from './i18n';
import { runStartupDoctor, type StartupDoctorCheck, type StartupDoctorReport } from './projects';
import { CheckRow } from './tabs/DoctorPanel';

const STATE = { ok: 'ok', warn: 'warn', error: 'bad' } as const;

const TITLES: Record<string, TranslationKey> = {
  runtime: 'startupDoctor.check.runtime',
  data_dir: 'startupDoctor.check.data_dir',
  ca: 'startupDoctor.check.ca',
  proxy_port: 'startupDoctor.check.proxy_port',
  api_port: 'startupDoctor.check.api_port',
  proxy_start: 'startupDoctor.check.proxy_start',
};

/** What to do about a result, keyed by `${id}.${status}`. */
const HINTS: Record<string, TranslationKey> = {
  'runtime.error': 'startupDoctor.hint.runtime',
  'data_dir.error': 'startupDoctor.hint.dataDir',
  'ca.warn': 'startupDoctor.hint.caMissing',
  'ca.error': 'startupDoctor.hint.caBroken',
  'proxy_port.error': 'startupDoctor.hint.proxyPort',
  'api_port.error': 'startupDoctor.hint.apiPort',
  'proxy_start.error': 'startupDoctor.hint.proxyStart',
};

/** Engine and proxy checks that need no open project. Everything stays local. */
export function StartupDoctor() {
  const t = useT();
  const [result, setResult] = useState<StartupDoctorReport | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    setBusy(true);
    setFailure(null);
    try {
      setResult(await runStartupDoctor());
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    // Paint the panel before the engine starts its checks.
    const timer = window.setTimeout(() => { void run(); }, 0);
    return () => window.clearTimeout(timer);
  }, [run]);

  const title = (check: StartupDoctorCheck) => TITLES[check.id] ? t(TITLES[check.id]) : check.id;
  const detail = (check: StartupDoctorCheck) => {
    const hint = HINTS[`${check.id}.${check.status}`];
    return hint ? `${t(hint)} ${check.detail}` : check.detail;
  };

  return (
    <section className="doctor startup-doctor" aria-label={t('startupDoctor.title')}>
      <div className="doctor-head">
        <div>
          <h3>{t('startupDoctor.title')}</h3>
          <p className="muted">{t('startupDoctor.scope')}</p>
        </div>
        <button type="button" onClick={() => void run()} disabled={busy}>
          {busy ? t('doctor.checking') : t('doctor.runAgain')}
        </button>
      </div>

      {failure && <div className="banner error" role="alert">{failure}</div>}
      {!result ? (busy && <p className="muted">{t('startupDoctor.running')}</p>) : (
        <>
          <div className="doctor-checks">
            {result.error && <CheckRow
              title={t('doctor.engine')}
              state="bad"
              detail={t('startupDoctor.engineFailed', { message: result.error })}
            />}
            {result.report?.checks.map((check) => <CheckRow
              key={check.id}
              title={title(check)}
              state={STATE[check.status] ?? 'neutral'}
              detail={detail(check)}
            />)}
          </div>
          {result.report && <p className="muted startup-doctor-meta">
            {t('startupDoctor.meta', {
              version: result.report.engine_version,
              platform: result.report.platform,
              engine: result.engine ?? '',
            })}
          </p>}
          {result.report?.checks.filter((check) => check.trace).map((check) => <details key={`${check.id}-trace`}>
            <summary>{t('startupDoctor.trace', { check: title(check) })}</summary>
            <pre className="startup-doctor-log">{check.trace}</pre>
          </details>)}
          {result.output && <details open={Boolean(result.error)}>
            <summary>{t('startupDoctor.output')}</summary>
            <pre className="startup-doctor-log">{result.output}</pre>
          </details>}
          {result.last_log && <details>
            <summary>{t('startupDoctor.lastLog')}</summary>
            <pre className="startup-doctor-log">{result.last_log}</pre>
          </details>}
        </>
      )}
    </section>
  );
}

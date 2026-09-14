import { useEffect, useState } from 'react';

import {
  caDownloadUrl,
  getCaInfo,
  getStatus,
  setLocalCapture,
  type CaInfo,
} from '../api/client';
import type { EngineStatus, LocalCaptureState } from '../api/types';
import { LOCALES, LOCALE_NAMES, useI18n, type Locale } from '../i18n';

/** Sentinel used to place a React node inside a translated sentence. */
const MARKER = '\u0000link\u0000';

function splitPlaceholder(text: string): string[] {
  return text.split(MARKER).flatMap((part, index) =>
    index === 0 ? [part] : [MARKER, part],
  );
}

export function SettingsTab() {
  const { t, locale, setLocale } = useI18n();
  const [ca, setCa] = useState<CaInfo | null>(null);
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCaInfo().then(setCa).catch((e) => setError((e as Error).message));
    getStatus().then(setStatus).catch(() => undefined);
  }, []);

  const host = status?.proxy.host ?? '127.0.0.1';
  const port = status?.proxy.port ?? 8080;

  return (
    <div className="settings-tab">
      {error && <div className="banner error">{error}</div>}

      <CaptureSection />

      <section>
        <h3>{t('settings.languageSection')}</h3>
        <div className="settings-row">
          <label htmlFor="locale-select">{t('settings.language')}</label>
          <select
            id="locale-select"
            aria-label={t('settings.language')}
            value={locale}
            onChange={(e) => setLocale(e.target.value as Locale)}
          >
            {LOCALES.map((code) => (
              <option key={code} value={code}>
                {LOCALE_NAMES[code]}
              </option>
            ))}
          </select>
        </div>
        <p className="muted">{t('settings.languageHelp')}</p>
      </section>

      <section>
        <h3>{t('settings.proxySection')}</h3>
        {status ? (
          <dl className="settings-grid mono">
            <dt>{t('common.status')}</dt>
            <dd className={status.proxy.running ? 'status-2xx' : 'status-5xx'}>
              {status.proxy.running
                ? t('settings.running')
                : t('settings.stopped')}
            </dd>
            <dt>{t('common.address')}</dt>
            <dd>
              {status.proxy.host}:{status.proxy.port}
            </dd>
            <dt>{t('common.version')}</dt>
            <dd>{status.version}</dd>
            <dt>{t('settings.projectDb')}</dt>
            <dd>{status.db_path}</dd>
            <dt>{t('settings.capturedFlows')}</dt>
            <dd>{status.flows}</dd>
          </dl>
        ) : (
          <p className="muted">{t('settings.engineUnreachable')}</p>
        )}
      </section>

      <section>
        <h3>{t('settings.caSection')}</h3>
        <p className="muted">{t('settings.caHelp')}</p>
        {ca ? (
          <>
            <dl className="settings-grid mono">
              <dt>{t('common.location')}</dt>
              <dd>{ca.confdir}</dd>
              <dt>{t('common.proxy')}</dt>
              <dd>{ca.proxy}</dd>
            </dl>
            <div className="ca-downloads">
              {Object.entries(ca.available).map(([format, exists]) => (
                <a
                  key={format}
                  className={exists ? 'ca-link' : 'ca-link disabled'}
                  href={exists ? caDownloadUrl(format) : undefined}
                  download
                >
                  {t('settings.caDownload', { format })}
                </a>
              ))}
            </div>
            <p className="muted">
              {/* Split around {link} so the anchor lands wherever the
                  translation puts it. */}
              {splitPlaceholder(t('settings.caMitmit', { link: MARKER })).map(
                (part, index) =>
                  part === MARKER ? (
                    <a
                      key="mitmit"
                      href={ca.install_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      mitm.it
                    </a>
                  ) : (
                    <span key={index}>{part}</span>
                  ),
              )}
            </p>
          </>
        ) : (
          <p className="muted">{t('settings.caLoading')}</p>
        )}
      </section>

      <section>
        <h3>{t('settings.browserSection')}</h3>
        <pre className="mono settings-code">
          {t('settings.browserHelp', { host, port })}
        </pre>
      </section>
    </div>
  );
}

/** Turns OS-level capture on and off. Kept separate because it owns its
 *  own request state and does not share anything with the rest of the tab. */
function CaptureSection() {
  const { t } = useI18n();
  const [mode, setMode] = useState<'off' | 'all' | 'filtered'>('off');
  const [filter, setFilter] = useState('');
  const [state, setState] = useState<LocalCaptureState | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getStatus()
      .then((s) => {
        const capture = s.local_capture;
        if (!capture) return;
        setState(capture);
        const spec = capture.spec ?? null;
        if (spec === null) setMode('off');
        else if (spec === '') setMode('all');
        else {
          setMode('filtered');
          setFilter(spec);
        }
      })
      .catch(() => undefined);
  }, []);

  const apply = async (next: 'off' | 'all' | 'filtered', spec: string) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      // null is off; '' is on with no filter, i.e. every application.
      const result = await setLocalCapture(
        next === 'off' ? null : next === 'all' ? '' : spec,
      );
      setState(result);
      setNote(result.restart_required ? t('capture.restartNeeded') : t('capture.applied'));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h3>{t('capture.section')}</h3>
      <p className="muted">{t('capture.help')}</p>

      <div className="capture-modes">
        {(['off', 'all', 'filtered'] as const).map((option) => (
          <label key={option}>
            <input
              type="radio"
              name="capture-mode"
              checked={mode === option}
              disabled={busy}
              onChange={() => {
                setMode(option);
                if (option !== 'filtered') void apply(option, '');
              }}
            />
            {t(`capture.${option}` as 'capture.off')}
          </label>
        ))}
      </div>

      {mode === 'filtered' && (
        <div className="capture-filter">
          <label htmlFor="capture-filter">{t('capture.filterLabel')}</label>
          <div className="row">
            <input
              id="capture-filter"
              value={filter}
              disabled={busy}
              placeholder={t('capture.filterPlaceholder')}
              onChange={(e) => setFilter(e.target.value)}
            />
            <button
              type="button"
              disabled={busy || !filter.trim()}
              onClick={() => void apply('filtered', filter)}
            >
              {t('capture.apply')}
            </button>
          </div>
          <p className="muted">{t('capture.filterHelp')}</p>
        </div>
      )}

      {note && <p className="muted">{note}</p>}
      {error && <div className="banner error">{error}</div>}

      {state && state.spec !== null && !state.approved && (
        <div className="banner warn">
          <strong>{t('dash.captureWaiting')}</strong>
          <span>{t('dash.captureWaitingHelp')}</span>
        </div>
      )}

      <p className="muted">{t('capture.pinningNote')}</p>
    </section>
  );
}

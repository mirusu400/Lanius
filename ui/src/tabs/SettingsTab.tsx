import { useEffect, useState } from 'react';

import {
  caDownloadUrl,
  exportProject,
  importProject,
  listProcesses,
  type ProcessInfo,
  getCaInfo,
  getListener,
  getStatus,
  getTlsState,
  setListener,
  setLocalCapture,
  setTlsProfile,
  type CaInfo,
} from '../api/client';
import type {
  EngineStatus,
  ListenerState,
  LocalCaptureState,
  TlsState,
} from '../api/types';
import {
  ruleIsValid,
  rulesToSpec,
  specToRules,
  type CaptureRule,
} from './captureRules';
import {
  LOCALES,
  LOCALE_NAMES,
  msg,
  rawMsg,
  renderMessage,
  useI18n,
  type Locale,
  type Message,
} from '../i18n';

/** Sentinel used to place a React node inside a translated sentence. */
const MARKER = '\u0000link\u0000';

const LOOPBACK = '127.0.0.1';
const ALL_INTERFACES = '0.0.0.0';
/** Dropdown value meaning "let me type an address myself". */
const OTHER_HOST = '\u0000other\u0000';

/** Is this address reachable only from this machine?
 *
 * Kept deliberately simple: the engine decides for real, this only drives
 * the warning shown while the user is still choosing.
 */
function isLoopback(host: string): boolean {
  return host === 'localhost' || host.startsWith('127.');
}

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

      <ListenerSection />

      <ProjectSection />

      <CaptureSection />

      <TlsSection />

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
function ListenerSection() {
  const { t } = useI18n();
  const [state, setState] = useState<ListenerState | null>(null);
  const [port, setPort] = useState('');
  const [host, setHost] = useState('');
  // Held separately: the dropdown falls back to a free-text field for an
  // address that is not one of the offered ones.
  const [customHost, setCustomHost] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Message | null>(null);
  const [error, setError] = useState<Message | null>(null);

  const load = (next: ListenerState) => {
    // An older engine, or a partial response, must not take the section
    // down: without an address list there is still a port to fix.
    setState({ ...next, addresses: next.addresses ?? [] });
    setPort(String(next.port ?? ''));
    setHost(next.host ?? LOOPBACK);
  };

  useEffect(() => {
    getListener()
      .then(load)
      .catch((err) => setError(rawMsg((err as Error).message)));
  }, []);

  if (!state) return null;

  const addresses =
    state.addresses.length > 0
      ? state.addresses
      : [
          { host: LOOPBACK, label: LOOPBACK },
          { host: ALL_INTERFACES, label: ALL_INTERFACES },
        ];
  const known = addresses.some((entry) => entry.host === host);
  const chosenHost = known ? host : customHost || host;
  const exposed = chosenHost !== '' && !isLoopback(chosenHost);
  const changed =
    chosenHost !== state.host || port !== String(state.port);

  const apply = async () => {
    setBusy(true);
    setNote(null);
    setError(null);
    const wanted = Number(port);
    try {
      const next = await setListener(chosenHost, wanted);
      load(next);
      setCustomHost('');
      setNote(msg('listener.applied', { host: next.host, port: next.port }));
    } catch (err) {
      setError(
        msg('listener.failed', {
          host: chosenHost,
          port: port,
          message: (err as Error).message,
        }),
      );
      // The engine rolls back, so say so rather than leaving the user
      // wondering whether they have a proxy at all.
      setNote(msg('listener.kept'));
      getListener().then(load).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h3>{t('listener.section')}</h3>
      <p className="muted">{t('listener.help')}</p>

      {!state.running && state.error && (
        <div className="banner error">
          {t('listener.down', { message: state.error })}
          <br />
          {t('listener.downHint')}
        </div>
      )}

      <div className="settings-row">
        <label htmlFor="listener-port">{t('listener.port')}</label>
        <input
          id="listener-port"
          type="number"
          min={1}
          max={65535}
          className="mono"
          value={port}
          disabled={busy}
          onChange={(event) => setPort(event.target.value)}
        />
      </div>

      <div className="settings-row">
        <label htmlFor="listener-host">{t('listener.bind')}</label>
        <select
          id="listener-host"
          value={known ? host : OTHER_HOST}
          disabled={busy}
          onChange={(event) => {
            if (event.target.value === OTHER_HOST) {
              setHost(OTHER_HOST);
              setCustomHost('');
            } else {
              setHost(event.target.value);
            }
          }}
        >
          {addresses.map((entry) => (
            <option key={entry.host} value={entry.host}>
              {entry.host === LOOPBACK || entry.host === ALL_INTERFACES
                ? `${entry.label} (${entry.host})`
                : entry.host}
            </option>
          ))}
          <option value={OTHER_HOST}>{t('listener.hostOther')}</option>
        </select>
      </div>

      {!known && (
        <div className="settings-row">
          <label htmlFor="listener-custom">{t('listener.hostOther')}</label>
          <input
            id="listener-custom"
            className="mono"
            placeholder={t('listener.hostPlaceholder')}
            value={customHost}
            disabled={busy}
            onChange={(event) => setCustomHost(event.target.value)}
          />
        </div>
      )}

      <div className="settings-row">
        <button
          type="button"
          disabled={busy || !changed || chosenHost === ''}
          onClick={() => void apply()}
        >
          {t('listener.apply')}
        </button>
      </div>

      <p className={exposed ? 'banner warn' : 'muted'}>
        {exposed ? t('listener.exposed') : t('listener.localOnly')}
      </p>

      {note && <p className="muted">{renderMessage(note, t)}</p>}
      {error && <div className="banner error">{renderMessage(error, t)}</div>}
    </section>
  );
}

function CaptureSection() {
  const { t } = useI18n();
  const [mode, setMode] = useState<'off' | 'all' | 'filtered'>('off');
  const [rules, setRules] = useState<CaptureRule[]>([]);
  const [state, setState] = useState<LocalCaptureState | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState<ProcessInfo[] | null>(null);

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
          setRules(specToRules(spec));
        }
      })
      .catch(() => undefined);
  }, []);

  const apply = async (next: typeof mode, nextRules: CaptureRule[]) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      // null is off; '' is on with no filter, i.e. every application.
      const spec =
        next === 'off' ? null : next === 'all' ? '' : rulesToSpec(nextRules);
      const result = await setLocalCapture(spec);
      setState(result);
      setNote(
        result.restart_required ? t('capture.restartNeeded') : t('capture.applied'),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const updateRules = (next: CaptureRule[]) => {
    setRules(next);
    // Applying on every keystroke would restart capture mid-word, so the
    // list is committed explicitly.
  };

  const openPicker = async () => {
    try {
      setPicker((await listProcesses(true)).items);
    } catch (err) {
      setError((err as Error).message);
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
                if (option !== 'filtered') void apply(option, rules);
              }}
            />
            {t(`capture.${option}` as 'capture.off')}
          </label>
        ))}
      </div>

      {mode === 'filtered' && (
        <div className="capture-rules">
          <p className="muted">{t('capture.rulesHelp')}</p>

          {rules.length === 0 ? (
            <p className="muted">{t('capture.noRules')}</p>
          ) : (
            <ul className="rule-list">
              {rules.map((rule, index) => (
                <li key={index}>
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    aria-label={t('capture.toggleRule', { value: rule.value })}
                    onChange={(e) =>
                      updateRules(
                        rules.map((r, i) =>
                          i === index ? { ...r, enabled: e.target.checked } : r,
                        ),
                      )
                    }
                  />
                  <select
                    aria-label={t('capture.ruleAction', { index: String(index + 1) })}
                    value={rule.action}
                    onChange={(e) =>
                      updateRules(
                        rules.map((r, i) =>
                          i === index
                            ? { ...r, action: e.target.value as CaptureRule['action'] }
                            : r,
                        ),
                      )
                    }
                  >
                    <option value="include">{t('capture.include')}</option>
                    <option value="exclude">{t('capture.exclude')}</option>
                  </select>
                  <input
                    className={
                      rule.value.includes(',') ? 'mono invalid' : 'mono'
                    }
                    aria-label={t('capture.ruleValue', { index: String(index + 1) })}
                    placeholder={t('capture.rulePlaceholder')}
                    value={rule.value}
                    onChange={(e) =>
                      updateRules(
                        rules.map((r, i) =>
                          i === index ? { ...r, value: e.target.value } : r,
                        ),
                      )
                    }
                  />
                  <button
                    type="button"
                    aria-label={t('capture.removeRule', { value: rule.value })}
                    onClick={() => updateRules(rules.filter((_, i) => i !== index))}
                  >
                    &times;
                  </button>
                </li>
              ))}
            </ul>
          )}

          {rules.some((rule) => rule.value.includes(',')) && (
            <p className="field-error">{t('capture.ruleComma')}</p>
          )}

          <div className="row">
            <button
              type="button"
              onClick={() =>
                updateRules([...rules, { value: '', action: 'include', enabled: true }])
              }
            >
              {t('capture.addRule')}
            </button>
            <button type="button" onClick={() => void openPicker()}>
              {t('capture.pick')}
            </button>
            <button
              type="button"
              disabled={
                busy ||
                rules.every((r) => !r.value.trim()) ||
                // A comma would silently split one rule into two, and the
                // engine refuses it anyway.
                rules.some((r) => r.value.trim() && !ruleIsValid(r))
              }
              onClick={() => void apply('filtered', rules)}
            >
              {t('capture.apply')}
            </button>
          </div>

          {picker && (
            <ul className="process-picker">
              {picker.map((process) => (
                <li key={process.path}>
                  <button
                    type="button"
                    onClick={() => {
                      // Add the full path: two apps can share a name, and
                      // the path is what the redirector matches on.
                      updateRules([
                        ...rules,
                        { value: process.path, action: 'include', enabled: true },
                      ]);
                      setPicker(null);
                    }}
                  >
                    <strong>{process.name}</strong>
                    <span className="mono">{process.path}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
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

/** Reshapes the handshake Lanius makes towards the server. */
function TlsSection() {
  const { t } = useI18n();
  const [state, setState] = useState<TlsState | null>(null);
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Message | null>(null);
  const [error, setError] = useState<Message | null>(null);

  useEffect(() => {
    getTlsState()
      .then((next) => {
        // Guard the shape: rendering maps over `available`, so a response
        // without it would take the whole Settings tab down.
        if (!next || !Array.isArray(next.available)) return;
        setState(next);
        setCustom(next.custom_ciphers ?? '');
      })
      .catch(() => undefined);
  }, []);

  const apply = async (profile: string, ciphers: string) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const next = await setTlsProfile(profile, ciphers);
      if (next && Array.isArray(next.available)) {
        setState(next);
        setCustom(next.custom_ciphers ?? '');
      }
      setNote(msg('tls.applied'));
    } catch (err) {
      setError(rawMsg((err as Error).message));
    } finally {
      setBusy(false);
    }
  };

  if (!state) return null;

  // The count is what actually reaches the server, so it is the useful
  // confirmation that a profile took effect.
  const cipherCount = state.ciphers ? state.ciphers.split(':').length : 0;

  return (
    <section>
      <h3>{t('tls.section')}</h3>
      <p className="muted">{t('tls.help')}</p>

      <div className="row tls-row">
        <label htmlFor="tls-profile">{t('tls.profile')}</label>
        <select
          id="tls-profile"
          value={state.profile}
          disabled={busy}
          onChange={(e) => void apply(e.target.value, custom)}
        >
          {state.available.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        {cipherCount > 0 && (
          <span className="muted">
            {t('tls.active', { count: String(cipherCount) })}
          </span>
        )}
      </div>

      <div className="tls-custom">
        <label htmlFor="tls-ciphers">{t('tls.customLabel')}</label>
        <div className="row">
          <input
            id="tls-ciphers"
            className="mono"
            value={custom}
            disabled={busy}
            placeholder={t('tls.customPlaceholder')}
            onChange={(e) => setCustom(e.target.value)}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => void apply(state.profile, custom)}
          >
            {t('tls.apply')}
          </button>
        </div>
      </div>

      {note && <p className="muted">{renderMessage(note, t)}</p>}
      {error && <div className="banner error">{renderMessage(error, t)}</div>}
      <p className="muted">{t('tls.limitation')}</p>
    </section>
  );
}

/** Export and import, plus a reminder that work is saved as you go. */
function ProjectSection() {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Message | null>(null);
  const [error, setError] = useState<Message | null>(null);

  const download = async (includeFlows: boolean) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const data = await exportProject(includeFlows);
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const stamp = new Date().toISOString().slice(0, 10);
      link.download = `lanius-${stamp}.lanius.json`;
      link.click();
      // Revoking immediately can cancel the download in some browsers.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      setError(rawMsg((err as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const result = await importProject(JSON.parse(await file.text()));
      setNote(
        msg('project.imported', {
          flows: String(result.flows ?? 0),
          scope: String(result.scope ?? 0),
        }),
      );
    } catch (err) {
      setError(msg('project.importFailed', { message: (err as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h3>{t('project.section')}</h3>
      <p className="muted">{t('project.help')}</p>

      <div className="project-actions">
        <button type="button" disabled={busy} onClick={() => void download(true)}>
          {t('project.export')}
        </button>
        <button type="button" disabled={busy} onClick={() => void download(false)}>
          {t('project.exportNoFlows')}
        </button>
        <label className="import-button">
          {t('project.import')}
          <input
            type="file"
            accept=".json,application/json"
            aria-label={t('project.import')}
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Importing throws away the open project, so ask first.
              if (file && window.confirm(t('project.confirmImport'))) {
                void upload(file);
              }
              event.target.value = '';
            }}
          />
        </label>
      </div>

      {note && <p className="muted">{renderMessage(note, t)}</p>}
      {error && <div className="banner error">{renderMessage(error, t)}</div>}
    </section>
  );
}

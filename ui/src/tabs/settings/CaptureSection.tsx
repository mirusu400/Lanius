/** Capturing traffic from apps that ignore proxy settings. */

import { useEffect, useState } from 'react';
import {
  getStatus,
  listProcesses,
  setLocalCapture,
  type ProcessInfo,
} from '../../api/client';
import type { LocalCaptureState } from '../../api/types';
import {
  ruleIsValid,
  rulesToSpec,
  specToRules,
  type CaptureRule,
} from '../captureRules';
import {
  useI18n,
} from '../../i18n';

export function CaptureSection() {
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

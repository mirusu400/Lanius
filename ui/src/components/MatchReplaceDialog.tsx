import { useEffect, useState } from 'react';

import { getMatchReplaceRules, previewMatchReplace, putMatchReplaceRules } from '../api/client';
import type { MatchReplaceRule } from '../api/types';
import { errorMessage, renderMessage, useT, type Message } from '../i18n';
import { Dialog } from './Dialog';
import { Split } from './Split';

function newRule(): MatchReplaceRule {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `rule-${Date.now()}`,
    name: '',
    enabled: true,
    phase: 'request',
    target: 'body',
    match: '',
    replace: '',
    regex: false,
    case_sensitive: true,
  };
}

export function MatchReplaceButton() {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        {t('matchReplace.button')}
      </button>
      <MatchReplaceDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export function MatchReplaceDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const [rules, setRules] = useState<MatchReplaceRule[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Message | null>(null);
  const [previewPhase, setPreviewPhase] = useState<MatchReplaceRule['phase']>('request');
  const [previewRaw, setPreviewRaw] = useState('');
  const [previewResult, setPreviewResult] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<Message | null>(null);

  useEffect(() => {
    if (!open) return;
    setBusy(true);
    setError(null);
    getMatchReplaceRules()
      .then(setRules)
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setBusy(false));
  }, [open]);

  const update = (id: string, patch: Partial<MatchReplaceRule>) => {
    setPreviewResult(null);
    setPreviewError(null);
    setRules((current) =>
      current.map((rule) => {
        if (rule.id !== id) return rule;
        const next = { ...rule, ...patch };
        if (next.phase === 'response' && next.target === 'url') next.target = 'body';
        return next;
      }),
    );
  };

  const runPreview = async () => {
    setPreviewBusy(true);
    setPreviewError(null);
    setPreviewResult(null);
    try {
      // A new draft rule may still be blank. The save action validates it;
      // preview runs the rules that currently have a match expression.
      const active = rules.filter((rule) => rule.match);
      const result = await previewMatchReplace(active, previewPhase, previewRaw);
      setPreviewResult(result.raw);
    } catch (err) {
      setPreviewError(errorMessage(err));
    } finally {
      setPreviewBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      setRules(await putMatchReplaceRules(rules));
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('matchReplace.title')}
      className="match-replace-dialog"
      footer={
        <>
          <button type="button" onClick={() => {
            setRules((value) => [...value, newRule()]);
            setPreviewResult(null);
            setPreviewError(null);
          }}>
            {t('matchReplace.add')}
          </button>
          <span className="spacer" />
          <button type="button" onClick={onClose}>{t('common.cancel')}</button>
          <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
            {t('matchReplace.save')}
          </button>
        </>
      }
    >
      <p className="muted">{t('matchReplace.help')}</p>
      {error && <div className="banner error">{renderMessage(error, t)}</div>}
      {rules.length === 0 && !busy ? (
        <p className="muted">{t('matchReplace.empty')}</p>
      ) : (
        <div className="match-replace-rules">
          {rules.map((rule) => (
            <section className="match-replace-rule" key={rule.id}>
              <div className="match-replace-rule-head">
                <label className="match-enabled">
                  <input type="checkbox" checked={rule.enabled} onChange={(event) => update(rule.id, { enabled: event.target.checked })} />
                  {t('common.enabled')}
                </label>
                <input
                  aria-label={t('common.name')}
                  placeholder={t('matchReplace.namePlaceholder')}
                  value={rule.name}
                  onChange={(event) => update(rule.id, { name: event.target.value })}
                />
                <button type="button" className="danger" onClick={() => {
                  setRules((value) => value.filter((item) => item.id !== rule.id));
                  setPreviewResult(null);
                  setPreviewError(null);
                }}>{t('common.delete')}</button>
              </div>
              <div className="match-replace-rule-options">
                <label>{t('matchReplace.phase')}
                  <select
                    value={rule.phase}
                    onChange={(event) => update(rule.id, { phase: event.target.value as MatchReplaceRule['phase'] })}
                  >
                    <option value="request">{t('detail.request')}</option>
                    <option value="response">{t('detail.response')}</option>
                  </select>
                </label>
                <label>{t('matchReplace.target')}
                  <select
                    value={rule.target}
                    onChange={(event) => update(rule.id, { target: event.target.value as MatchReplaceRule['target'] })}
                  >
                    {rule.phase === 'request' && <option value="url">URL</option>}
                    <option value="headers">{t('detail.headers')}</option>
                    <option value="body">{t('detail.body')}</option>
                    <option value="message">{t(rule.phase === 'request' ? 'matchReplace.wholeRequest' : 'matchReplace.wholeResponse')}</option>
                  </select>
                </label>
                <label className="match-replace-check"><input type="checkbox" checked={rule.regex} onChange={(event) => update(rule.id, { regex: event.target.checked })} />{t('matchReplace.regex')}</label>
                <label className="match-replace-check"><input type="checkbox" checked={rule.case_sensitive} onChange={(event) => update(rule.id, { case_sensitive: event.target.checked })} />{t('matchReplace.caseSensitive')}</label>
              </div>
              <Split
                direction="horizontal"
                storageKey="lanius.split.matchReplaceFields"
                className="match-replace-fields"
                first={<label>{t('matchReplace.match')}
                  <textarea className="mono" value={rule.match} onChange={(event) => update(rule.id, { match: event.target.value })} />
                </label>}
                second={<label>{t('matchReplace.replace')}
                  <textarea className="mono" value={rule.replace} onChange={(event) => update(rule.id, { replace: event.target.value })} />
                </label>}
              />
            </section>
          ))}
        </div>
      )}
      <section className="match-replace-preview">
        <div className="match-replace-preview-head">
          <div>
            <h4>{t('matchReplace.previewTitle')}</h4>
            <p className="muted">{t('matchReplace.previewHelp')}</p>
          </div>
          <select
            aria-label={t('matchReplace.previewPhase')}
            value={previewPhase}
            onChange={(event) => {
              setPreviewPhase(event.target.value as MatchReplaceRule['phase']);
              setPreviewResult(null);
              setPreviewError(null);
            }}
          >
            <option value="request">{t('detail.request')}</option>
            <option value="response">{t('detail.response')}</option>
          </select>
          <button type="button" disabled={busy || previewBusy || !previewRaw.trim()} onClick={() => void runPreview()}>
            {t('matchReplace.previewButton')}
          </button>
        </div>
        {previewError && <div className="banner error">{renderMessage(previewError, t)}</div>}
        <Split
          direction="horizontal"
          storageKey="lanius.split.matchReplacePreview"
          className="match-replace-preview-panes"
          first={<label>{t(previewPhase === 'request' ? 'matchReplace.rawRequest' : 'matchReplace.rawResponse')}
            <textarea
              className="mono"
              value={previewRaw}
              placeholder={previewPhase === 'request' ? 'GET /old HTTP/1.1\r\nHost: example.com\r\n\r\n' : 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n'}
              onChange={(event) => {
                setPreviewRaw(event.target.value);
                setPreviewResult(null);
                setPreviewError(null);
              }}
            />
          </label>}
          second={<label>{t('matchReplace.previewResult')}
            <textarea className="mono" value={previewResult ?? ''} readOnly />
          </label>}
        />
      </section>
    </Dialog>
  );
}

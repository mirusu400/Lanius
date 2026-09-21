import { useEffect, useState } from 'react';

import { getMatchReplaceRules, putMatchReplaceRules } from '../api/client';
import type { MatchReplaceRule } from '../api/types';
import { errorMessage, renderMessage, useT, type Message } from '../i18n';
import { Dialog } from './Dialog';

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
    setRules((current) =>
      current.map((rule) => {
        if (rule.id !== id) return rule;
        const next = { ...rule, ...patch };
        if (next.phase === 'response' && next.target === 'url') next.target = 'body';
        return next;
      }),
    );
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
          <button type="button" onClick={() => setRules((value) => [...value, newRule()])}>
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
              <label className="match-enabled">
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  onChange={(event) => update(rule.id, { enabled: event.target.checked })}
                />
                {t('common.enabled')}
              </label>
              <input
                aria-label={t('common.name')}
                placeholder={t('matchReplace.namePlaceholder')}
                value={rule.name}
                onChange={(event) => update(rule.id, { name: event.target.value })}
              />
              <select
                aria-label={t('matchReplace.phase')}
                value={rule.phase}
                onChange={(event) => update(rule.id, { phase: event.target.value as MatchReplaceRule['phase'] })}
              >
                <option value="request">{t('detail.request')}</option>
                <option value="response">{t('detail.response')}</option>
              </select>
              <select
                aria-label={t('matchReplace.target')}
                value={rule.target}
                onChange={(event) => update(rule.id, { target: event.target.value as MatchReplaceRule['target'] })}
              >
                {rule.phase === 'request' && <option value="url">URL</option>}
                <option value="headers">{t('detail.headers')}</option>
                <option value="body">{t('detail.body')}</option>
              </select>
              <textarea
                aria-label={t('matchReplace.match')}
                className="mono"
                placeholder={t('matchReplace.match')}
                value={rule.match}
                onChange={(event) => update(rule.id, { match: event.target.value })}
              />
              <textarea
                aria-label={t('matchReplace.replace')}
                className="mono"
                placeholder={t('matchReplace.replace')}
                value={rule.replace}
                onChange={(event) => update(rule.id, { replace: event.target.value })}
              />
              <label><input type="checkbox" checked={rule.regex} onChange={(event) => update(rule.id, { regex: event.target.checked })} />{t('matchReplace.regex')}</label>
              <label><input type="checkbox" checked={rule.case_sensitive} onChange={(event) => update(rule.id, { case_sensitive: event.target.checked })} />{t('matchReplace.caseSensitive')}</label>
              <button type="button" className="danger" onClick={() => setRules((value) => value.filter((item) => item.id !== rule.id))}>
                {t('common.delete')}
              </button>
            </section>
          ))}
        </div>
      )}
    </Dialog>
  );
}

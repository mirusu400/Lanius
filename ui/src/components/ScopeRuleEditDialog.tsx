import { useId, useRef, useState } from 'react';

import type { ScopeRule } from '../api/types';
import { errorMessage, renderMessage, useT, type Message } from '../i18n';
import { Dialog } from './Dialog';
import { UndoableInput } from './UndoableText';

export function ScopeRuleEditDialog({ rule, onSave, onClose }: {
  rule: ScopeRule;
  onSave: (changes: Partial<ScopeRule>) => Promise<void>;
  onClose: () => void;
}) {
  const t = useT();
  const formId = useId();
  const [draft, setDraft] = useState(rule);
  const [port, setPort] = useState(rule.port === null ? '' : String(rule.port));
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState<Message | null>(null);
  const set = (changes: Partial<ScopeRule>) => setDraft((current) => ({ ...current, ...changes }));
  const close = () => {
    if (!saving.current) onClose();
  };

  const save = async () => {
    if (saving.current) return;
    const next = { ...draft, port: port === '' ? null : Number(port) };
    // Only send edited fields so a concurrent toggle is preserved.
    const changes = Object.fromEntries(Object.entries(next)
      .filter(([key, value]) => key !== 'id' && value !== rule[key as keyof ScopeRule]));
    if (Object.keys(changes).length === 0) {
      onClose();
      return;
    }
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      await onSave(changes);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={t('scope.editRule')}
      className="scope-rule-dialog"
      onClose={close}
      footer={<>
        <button type="button" disabled={busy} onClick={close}>{t('common.cancel')}</button>
        <button type="submit" form={formId} className="primary" disabled={busy}>{t('scope.saveRule')}</button>
      </>}
    >
      <form id={formId} onSubmit={(event) => { event.preventDefault(); void save(); }}>
        {error && <div className="banner error" role="alert">{renderMessage(error, t)}</div>}
        <fieldset className="scope-rule-fields" disabled={busy}>
          <label>{t('scope.kind')}
            <select value={draft.kind} onChange={(event) => set({ kind: event.target.value as ScopeRule['kind'] })}>
              <option value="include">{t('scope.include')}</option>
              <option value="exclude">{t('scope.exclude')}</option>
            </select>
          </label>
          <label>{t('scope.hostPattern')}
            <UndoableInput autoFocus value={draft.host} onValueChange={(host) => set({ host })} />
          </label>
          <label>{t('scope.pathPattern')}
            <UndoableInput value={draft.path} onValueChange={(path) => set({ path })} />
          </label>
          <label>{t('scope.protocol')}
            <select value={draft.protocol} onChange={(event) => set({ protocol: event.target.value as ScopeRule['protocol'] })}>
              <option value="any">{t('scope.any')}</option>
              <option value="http">HTTP</option>
              <option value="https">HTTPS</option>
            </select>
          </label>
          <label>{t('scope.port')}
            <UndoableInput type="number" min={1} max={65535} step={1} placeholder={t('scope.any')}
              value={port} onValueChange={setPort} />
          </label>
          <label>{t('scope.matchType')}
            <select value={draft.match_type} onChange={(event) => set({ match_type: event.target.value as ScopeRule['match_type'] })}>
              <option value="glob">{t('scope.glob')}</option>
              <option value="regex">{t('scope.regex')}</option>
            </select>
          </label>
          <label className="scope-rule-enabled">
            <input type="checkbox" checked={draft.enabled} onChange={(event) => set({ enabled: event.target.checked })} />
            {t('common.enabled')}
          </label>
        </fieldset>
        <p className="muted">{t('scope.editPatternHint')}</p>
      </form>
    </Dialog>
  );
}

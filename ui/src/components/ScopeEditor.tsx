import { useState } from 'react';

import type { ScopeRule, ScopeState } from '../api/types';
import { describeRule, summarizeScope } from '../tabs/targetModel';
import { errorMessage, renderMessage, useT, type Message } from '../i18n';
import { ContextMenu, useContextMenu } from './ContextMenu';
import { ResizableFillCell, ResizableFillHeader, ResizableHeader, ResizableTable, useResizableColumns } from './ResizableColumns';
import { ScopeRuleEditDialog } from './ScopeRuleEditDialog';
import { UndoableInput } from './UndoableText';

interface Props {
  scope: ScopeState;
  onAddUrl: (url: string, kind: 'include' | 'exclude', regex: boolean) => Promise<void>;
  onUpdate: (id: number, changes: Partial<ScopeRule>) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onRestrictCapture: (value: boolean) => Promise<void>;
}

export function ScopeEditor({
  scope,
  onAddUrl,
  onUpdate,
  onDelete,
  onRestrictCapture,
}: Props) {
  const t = useT();
  const columns = useResizableColumns('lanius.columns.scope', [120, 480, 100, 100]);
  const [url, setUrl] = useState('');
  const [kind, setKind] = useState<'include' | 'exclude'>('include');
  const [regex, setRegex] = useState(false);
  const [error, setError] = useState<Message | null>(null);
  const [editingRule, setEditingRule] = useState<ScopeRule | null>(null);
  const [editingKind, setEditingKind] = useState<number | null>(null);
  const [savingKind, setSavingKind] = useState<number | null>(null);
  const menu = useContextMenu<ScopeRule>();
  const summary = summarizeScope(scope.rules);

  const edit = (rule: ScopeRule) => {
    if (rule.id === null || savingKind !== null) return;
    setEditingKind(null);
    setEditingRule(rule);
  };

  const update = async (rule: ScopeRule, changes: Partial<ScopeRule>) => {
    if (rule.id === null) return;
    setError(null);
    try {
      await onUpdate(rule.id, changes);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const updateKind = async (rule: ScopeRule, value: ScopeRule['kind']) => {
    if (value === rule.kind || savingKind !== null) return;
    setSavingKind(rule.id);
    await update(rule, { kind: value });
    setSavingKind(null);
    setEditingKind(null);
  };

  const add = async () => {
    if (!url.trim()) return;
    try {
      await onAddUrl(url.trim(), kind, regex);
      setUrl('');
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div className="scope-editor">
      <div className="scope-controls">
        <select
          value={kind}
          aria-label={t('scope.kind')}
          onChange={(e) => setKind(e.target.value as 'include' | 'exclude')}
        >
          <option value="include">{t('scope.include')}</option>
          <option value="exclude">{t('scope.exclude')}</option>
        </select>
        <UndoableInput
          className="scope-url"
          aria-label={t('scope.url')}
          placeholder={t('scope.urlPlaceholder')}
          value={url}
          onValueChange={setUrl}
          onKeyDown={(e) => e.key === 'Enter' && void add()}
        />
        <button onClick={() => void add()}>{t('scope.addRule')}</button>
        <label>
          <input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} />
          {t('scope.regex')}
        </label>
        <span className="spacer" />
        <label>
          <input
            type="checkbox"
            checked={scope.restrict_capture}
            onChange={(e) => void onRestrictCapture(e.target.checked)}
          />
          {t('scope.restrictCapture')}
        </label>
      </div>
      <p className="muted scope-pattern-hint">{t(regex ? 'scope.regexHint' : 'scope.hostPatternHint')}</p>
      {error && <div className="banner error" role="alert">{renderMessage(error, t)}</div>}
      <div className="scope-summary muted">
        {t('scope.summary', {
          includes: summary.includes,
          excludes: summary.excludes,
        })}
        {summary.includes === 0 && t('scope.noIncludeHint')}
      </div>
      <ResizableTable columns={columns} className="flow-table scope-table">
        <thead>
          <tr>
            {[t('scope.kind'), t('scope.rule'), t('common.enabled'), t('common.delete')].map((label, index) => (
              <ResizableHeader key={index} label={label} index={index} columns={columns} resizeLabel={t('table.resizeColumn', { column: label })} />
            ))}
            <ResizableFillHeader />
          </tr>
        </thead>
        <tbody>
          {scope.rules.length === 0 && (
            <tr>
              <td colSpan={4} className="empty">
                {t('scope.noRules')}
              </td>
              <ResizableFillCell />
            </tr>
          )}
          {scope.rules.map((rule) => (
            <tr key={rule.id ?? describeRule(rule)} onContextMenu={(event) => menu.open(event, rule)}>
              <td className={`scope-editable ${rule.kind === 'include' ? 'incl' : 'excl'}`}
                tabIndex={rule.id === null ? undefined : 0}
                title={t('scope.editKindHint')}
                onDoubleClick={() => savingKind === null && setEditingKind(rule.id)}
                onKeyDown={(event) => {
                  if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === 'F2')) {
                    event.preventDefault();
                    if (savingKind === null) setEditingKind(rule.id);
                  }
                }}>
                {rule.id !== null && editingKind === rule.id ? (
                  <select autoFocus aria-label={t('scope.kind')} value={rule.kind} disabled={savingKind !== null}
                    onChange={(event) => void updateKind(rule, event.target.value as ScopeRule['kind'])}
                    onBlur={() => setEditingKind(null)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.stopPropagation();
                        setEditingKind(null);
                      }
                    }}>
                    <option value="include">{t('scope.include')}</option>
                    <option value="exclude">{t('scope.exclude')}</option>
                  </select>
                ) : rule.kind === 'include' ? t('scope.include') : t('scope.exclude')}
              </td>
              <td className="mono scope-editable" tabIndex={rule.id === null ? undefined : 0}
                title={t('scope.editRuleHint')}
                onDoubleClick={() => edit(rule)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === 'F2') {
                    event.preventDefault();
                    edit(rule);
                  }
                }}>{describeRule(rule)}</td>
              <td>
                <input
                  type="checkbox"
                  aria-label={t('scope.toggle', { rule: describeRule(rule) })}
                  checked={rule.enabled}
                  disabled={savingKind === rule.id}
                  onChange={(e) =>
                    void update(rule, { enabled: e.target.checked })
                  }
                />
              </td>
              <td>
                <button
                  className="danger"
                  disabled={savingKind === rule.id}
                  aria-label={t('scope.delete', { rule: describeRule(rule) })}
                  onClick={() => rule.id !== null && void onDelete(rule.id)}
                >
                  {t('common.delete')}
                </button>
              </td>
              <ResizableFillCell />
            </tr>
          ))}
        </tbody>
      </ResizableTable>
      <ContextMenu position={menu.position} onClose={menu.close} items={[
        {
          label: t('scope.editRule'),
          disabled: menu.target?.id == null || savingKind !== null,
          onSelect: () => {
            const rule = scope.rules.find((rule) => rule.id === menu.target?.id);
            if (rule) edit(rule);
          },
        },
      ]} />
      {editingRule && <ScopeRuleEditDialog key={editingRule.id} rule={editingRule}
        onSave={(changes) => onUpdate(editingRule.id!, changes)}
        onClose={() => setEditingRule(null)} />}
    </div>
  );
}

import { useState } from 'react';

import type { ScopeState } from '../api/types';
import { describeRule, summarizeScope } from '../tabs/targetModel';
import { useT } from '../i18n';

interface Props {
  scope: ScopeState;
  onAddUrl: (url: string, kind: 'include' | 'exclude') => Promise<void>;
  onToggle: (id: number, enabled: boolean) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onRestrictCapture: (value: boolean) => Promise<void>;
}

export function ScopeEditor({
  scope,
  onAddUrl,
  onToggle,
  onDelete,
  onRestrictCapture,
}: Props) {
  const t = useT();
  const [url, setUrl] = useState('');
  const [kind, setKind] = useState<'include' | 'exclude'>('include');
  const [error, setError] = useState<string | null>(null);
  const summary = summarizeScope(scope.rules);

  const add = async () => {
    if (!url.trim()) return;
    try {
      await onAddUrl(url.trim(), kind);
      setUrl('');
      setError(null);
    } catch (err) {
      setError((err as Error).message);
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
        <input
          className="scope-url"
          aria-label={t('scope.url')}
          placeholder={t('scope.urlPlaceholder')}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void add()}
        />
        <button onClick={() => void add()}>{t('scope.addRule')}</button>
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
      {error && <div className="banner error">{error}</div>}
      <div className="scope-summary muted">
        {t('scope.summary', {
          includes: summary.includes,
          excludes: summary.excludes,
        })}
        {summary.includes === 0 && t('scope.noIncludeHint')}
      </div>
      <table className="flow-table scope-table">
        <thead>
          <tr>
            <th className="col-method">{t('scope.kind')}</th>
            <th>{t('scope.rule')}</th>
            <th className="col-size">{t('common.enabled')}</th>
            <th className="col-size" />
          </tr>
        </thead>
        <tbody>
          {scope.rules.length === 0 && (
            <tr>
              <td colSpan={4} className="empty">
                {t('scope.noRules')}
              </td>
            </tr>
          )}
          {scope.rules.map((rule) => (
            <tr key={rule.id ?? describeRule(rule)}>
              <td className={rule.kind === 'include' ? 'incl' : 'excl'}>
                {rule.kind === 'include' ? t('scope.include') : t('scope.exclude')}
              </td>
              <td className="mono">{describeRule(rule)}</td>
              <td>
                <input
                  type="checkbox"
                  aria-label={t('scope.toggle', { rule: describeRule(rule) })}
                  checked={rule.enabled}
                  onChange={(e) =>
                    rule.id !== null && void onToggle(rule.id, e.target.checked)
                  }
                />
              </td>
              <td>
                <button
                  className="danger"
                  aria-label={t('scope.delete', { rule: describeRule(rule) })}
                  onClick={() => rule.id !== null && void onDelete(rule.id)}
                >
                  {t('common.delete')}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

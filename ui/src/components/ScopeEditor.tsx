import { useState } from 'react';

import type { ScopeState } from '../api/types';
import { describeRule, summarizeScope } from '../tabs/targetModel';

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
          aria-label="rule kind"
          onChange={(e) => setKind(e.target.value as 'include' | 'exclude')}
        >
          <option value="include">Include</option>
          <option value="exclude">Exclude</option>
        </select>
        <input
          className="scope-url"
          aria-label="scope url"
          placeholder="https://target.com/app"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void add()}
        />
        <button onClick={() => void add()}>규칙 추가</button>
        <span className="spacer" />
        <label>
          <input
            type="checkbox"
            checked={scope.restrict_capture}
            onChange={(e) => void onRestrictCapture(e.target.checked)}
          />
          스코프 밖 트래픽 캡처 안 함
        </label>
      </div>
      {error && <div className="banner error">{error}</div>}
      <div className="scope-summary muted">
        include {summary.includes} · exclude {summary.excludes}
        {summary.includes === 0 && ' — include 규칙이 없으면 전부 스코프입니다'}
      </div>
      <table className="flow-table scope-table">
        <thead>
          <tr>
            <th className="col-method">Kind</th>
            <th>Rule</th>
            <th className="col-size">Enabled</th>
            <th className="col-size" />
          </tr>
        </thead>
        <tbody>
          {scope.rules.length === 0 && (
            <tr>
              <td colSpan={4} className="empty">
                규칙이 없습니다. URL을 입력해 스코프를 정의하세요.
              </td>
            </tr>
          )}
          {scope.rules.map((rule) => (
            <tr key={rule.id ?? describeRule(rule)}>
              <td className={rule.kind === 'include' ? 'incl' : 'excl'}>
                {rule.kind}
              </td>
              <td className="mono">{describeRule(rule)}</td>
              <td>
                <input
                  type="checkbox"
                  aria-label={`toggle ${describeRule(rule)}`}
                  checked={rule.enabled}
                  onChange={(e) =>
                    rule.id !== null && void onToggle(rule.id, e.target.checked)
                  }
                />
              </td>
              <td>
                <button
                  className="danger"
                  aria-label={`delete ${describeRule(rule)}`}
                  onClick={() => rule.id !== null && void onDelete(rule.id)}
                >
                  삭제
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

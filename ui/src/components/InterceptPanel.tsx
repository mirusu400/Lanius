import { useEffect, useMemo, useState } from 'react';

import { dropFlow, forwardAll, forwardFlow } from '../api/client';
import type { InterceptRules, PausedFlow } from '../api/types';
import { editsFromText, renderPaused } from '../tabs/interceptModel';

interface Props {
  rules: InterceptRules;
  paused: PausedFlow[];
  onToggle: (patch: Partial<InterceptRules>) => void;
  onResolved: (id: string) => void;
}

export function InterceptPanel({
  rules,
  paused,
  onToggle,
  onResolved,
}: Props) {
  const current = paused[0] ?? null;
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const original = useMemo(
    () => (current ? renderPaused(current) : ''),
    [current],
  );

  useEffect(() => {
    setText(original);
    setError(null);
  }, [original, current?.id]);

  const act = async (action: 'forward' | 'drop') => {
    if (!current) return;
    try {
      if (action === 'drop') {
        await dropFlow(current.id);
      } else {
        const edits =
          text === original ? {} : editsFromText(current.phase, text);
        await forwardFlow(current.id, edits);
      }
      onResolved(current.id);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="intercept-panel">
      <div className="intercept-controls">
        <button
          className={rules.enabled ? 'toggle on' : 'toggle'}
          onClick={() => onToggle({ enabled: !rules.enabled })}
        >
          {rules.enabled ? 'Intercept is on' : 'Intercept is off'}
        </button>
        <label>
          <input
            type="checkbox"
            checked={rules.intercept_requests}
            onChange={(e) => onToggle({ intercept_requests: e.target.checked })}
          />
          요청
        </label>
        <label>
          <input
            type="checkbox"
            checked={rules.intercept_responses}
            onChange={(e) =>
              onToggle({ intercept_responses: e.target.checked })
            }
          />
          응답
        </label>
        <input
          className="host"
          placeholder="host 필터"
          value={rules.host_filter ?? ''}
          onChange={(e) => onToggle({ host_filter: e.target.value })}
        />
        <span className="spacer" />
        <span className="queue">대기 {paused.length}건</span>
        <button onClick={() => act('forward')} disabled={!current}>
          Forward
        </button>
        <button className="danger" onClick={() => act('drop')} disabled={!current}>
          Drop
        </button>
        <button
          onClick={() => void forwardAll().then(() => onResolved('*'))}
          disabled={paused.length === 0}
        >
          Forward all
        </button>
      </div>
      {error && <div className="banner error">{error}</div>}
      {current ? (
        <>
          <div className="detail-url mono">
            <strong>{current.phase === 'request' ? '요청 대기' : '응답 대기'}</strong>{' '}
            {current.scheme}://{current.host}
            {current.path}
          </div>
          <textarea
            className="intercept-editor mono"
            value={text}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
          />
        </>
      ) : (
        <div className="intercept-idle muted">
          {rules.enabled
            ? '인터셉트 활성화됨 — 다음 요청을 기다리는 중입니다.'
            : '인터셉트가 꺼져 있습니다. 켜면 요청을 붙잡아 편집할 수 있습니다.'}
        </div>
      )}
    </div>
  );
}

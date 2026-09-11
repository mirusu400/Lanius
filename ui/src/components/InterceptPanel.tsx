import { useEffect, useMemo, useState } from 'react';

import { dropFlow, forwardAll, forwardFlow } from '../api/client';
import type { InterceptRules, PausedFlow } from '../api/types';
import { editsFromText, renderPaused } from '../tabs/interceptModel';
import { errorText, useT } from '../i18n';

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
  const t = useT();
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
      setError(errorText(err, t));
    }
  };

  return (
    <div className="intercept-panel">
      <div className="intercept-controls">
        <button
          className={rules.enabled ? 'toggle on' : 'toggle'}
          onClick={() => onToggle({ enabled: !rules.enabled })}
        >
          {rules.enabled ? t('intercept.on') : t('intercept.off')}
        </button>
        <label>
          <input
            type="checkbox"
            checked={rules.intercept_requests}
            onChange={(e) => onToggle({ intercept_requests: e.target.checked })}
          />
          {t('intercept.requests')}
        </label>
        <label>
          <input
            type="checkbox"
            checked={rules.intercept_responses}
            onChange={(e) =>
              onToggle({ intercept_responses: e.target.checked })
            }
          />
          {t('intercept.responses')}
        </label>
        <input
          className="host"
          placeholder={t('intercept.hostFilter')}
          value={rules.host_filter ?? ''}
          onChange={(e) => onToggle({ host_filter: e.target.value })}
        />
        <span className="spacer" />
        <span className="queue">
          {t('intercept.queued', { count: paused.length })}
        </span>
        <button onClick={() => act('forward')} disabled={!current}>
          {t('intercept.forward')}
        </button>
        <button className="danger" onClick={() => act('drop')} disabled={!current}>
          {t('intercept.drop')}
        </button>
        <button
          onClick={() => void forwardAll().then(() => onResolved('*'))}
          disabled={paused.length === 0}
        >
          {t('intercept.forwardAll')}
        </button>
      </div>
      {error && <div className="banner error">{error}</div>}
      {current ? (
        <>
          <div className="detail-url mono">
            <strong>
              {current.phase === 'request'
                ? t('intercept.waitingRequest')
                : t('intercept.waitingResponse')}
            </strong>{' '}
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
          {rules.enabled ? t('intercept.idleOn') : t('intercept.idleOff')}
        </div>
      )}
    </div>
  );
}

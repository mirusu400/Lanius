import { useEffect, useMemo, useState } from 'react';

import { dropFlow, forwardAll, forwardFlow } from '../api/client';
import type { InterceptRules, PausedFlow } from '../api/types';
import { editsFromText, renderPaused } from '../tabs/interceptModel';
import { errorMessage, renderMessage, useT, type Message } from '../i18n';
import { OpenBrowserButton } from './OpenBrowserButton';
import { MatchReplaceButton } from './MatchReplaceDialog';

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
  // Which held request is being shown. Burp lets you pick from the queue
  // rather than only ever seeing the oldest, which matters once several
  // are waiting and the one you care about is not first.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const current =
    paused.find((flow) => flow.id === selectedId) ?? paused[0] ?? null;
  const [text, setText] = useState('');
  const [error, setError] = useState<Message | null>(null);
  const original = useMemo(
    () => (current ? renderPaused(current) : ''),
    [current],
  );

  useEffect(() => {
    setText(original);
    setError(null);
  }, [original, current?.id]);

  // Follow the queue: when the shown request is forwarded or dropped, fall
  // back to whatever is at the front rather than showing an empty pane.
  useEffect(() => {
    if (selectedId && !paused.some((flow) => flow.id === selectedId)) {
      setSelectedId(null);
    }
  }, [paused, selectedId]);

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
      setError(errorMessage(err));
    }
  };

  return (
    <div className="intercept-panel">
      <div className="intercept-controls">
        <OpenBrowserButton />
        <MatchReplaceButton />
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
      {error && <div className="banner error">{renderMessage(error, t)}</div>}
      {paused.length > 1 && (
        <ul className="intercept-queue" aria-label={t('intercept.queueLabel')}>
          {paused.map((flow) => (
            <li key={flow.id}>
              <button
                type="button"
                className={flow.id === current?.id ? 'active' : undefined}
                onClick={() => setSelectedId(flow.id)}
              >
                <span className={`phase phase-${flow.phase}`}>
                  {flow.phase === 'request'
                    ? t('intercept.phaseRequest')
                    : t('intercept.phaseResponse')}
                </span>
                <span className="method mono">{flow.method}</span>
                <span className="target mono" title={`${flow.host}${flow.path}`}>
                  {flow.host}
                  {flow.path}
                </span>
                {flow.status_code != null && (
                  <span className="mono muted">{flow.status_code}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
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

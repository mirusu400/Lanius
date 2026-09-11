import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  getAttack,
  startAttack,
  stopAttack,
  type AttackConfig,
} from '../api/client';
import { connectStream } from '../api/stream';
import type { Attack, AttackType } from '../api/types';
import {
  ATTACK_TYPES,
  addMarker,
  clearMarkers,
  countPositions,
  estimateRequests,
  markOutliers,
  parsePayloads,
  requiredSets,
} from './intruderModel';
import { subscribeTarget } from './intruderStore';

const DEFAULT_TEMPLATE = 'GET /?q=\u00a7test\u00a7 HTTP/1.1\nHost: example.com\n\n';

export function IntruderTab() {
  const [url, setUrl] = useState('http://example.com');
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE);
  const [attackType, setAttackType] = useState<AttackType>('sniper');
  const [payloadText, setPayloadText] = useState(['a\nb\nc']);
  const [attack, setAttack] = useState<Attack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const attackIdRef = useRef<string | null>(null);

  useEffect(
    () =>
      subscribeTarget((target) => {
        if (!target) return;
        setUrl(target.url);
        setTemplate(target.template);
        setAttack(null);
      }),
    [],
  );

  const positions = countPositions(template);
  const sets = useMemo(
    () => payloadText.map((text) => parsePayloads(text)),
    [payloadText],
  );
  const needed = requiredSets(attackType, Math.max(positions, 0));
  const estimate =
    positions > 0 ? estimateRequests(attackType, positions, sets) : 0;

  // Keep the payload set count in step with the attack type / positions.
  useEffect(() => {
    setPayloadText((prev) => {
      if (prev.length === needed) return prev;
      if (prev.length < needed) {
        return [...prev, ...Array(needed - prev.length).fill('')];
      }
      return prev.slice(0, needed);
    });
  }, [needed]);

  const refresh = useCallback(async (id: string) => {
    try {
      setAttack(await getAttack(id));
    } catch {
      /* attack may not exist yet */
    }
  }, []);

  useEffect(
    () =>
      connectStream({
        onEvent: (event) => {
          if (
            event.type !== 'intruder.result' &&
            event.type !== 'intruder.finished'
          ) {
            return;
          }
          const id = attackIdRef.current;
          if (!id) return;
          void refresh(id);
        },
      }),
    [refresh],
  );

  const mark = () => {
    const editor = editorRef.current;
    if (!editor) return;
    const next = addMarker(
      template,
      editor.selectionStart,
      editor.selectionEnd,
    );
    setTemplate(next);
  };

  const launch = async () => {
    setError(null);
    const config: AttackConfig = {
      url,
      template,
      attack_type: attackType,
      payload_sets: sets,
    };
    try {
      const started = await startAttack(config);
      attackIdRef.current = started.id;
      setAttack({ ...started, results: [] });
      void refresh(started.id);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const halt = async () => {
    if (!attack) return;
    await stopAttack(attack.id);
    void refresh(attack.id);
  };

  const outliers = useMemo(
    () => markOutliers(attack?.results ?? []),
    [attack],
  );
  const running = attack?.status === 'running' || attack?.status === 'pending';

  return (
    <div className="intruder-tab">
      <div className="intruder-controls">
        <input
          className="target"
          aria-label="target url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <select
          aria-label="attack type"
          value={attackType}
          onChange={(e) => setAttackType(e.target.value as AttackType)}
        >
          {ATTACK_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <button onClick={mark}>Add §</button>
        <button onClick={() => setTemplate(clearMarkers(template))}>
          Clear §
        </button>
        <span className="spacer" />
        <span className="muted">
          위치 {positions < 0 ? '오류' : positions} · 요청 {estimate}건
        </span>
        <button className="send" onClick={launch} disabled={running}>
          {running ? 'Attacking…' : 'Start attack'}
        </button>
        {running && <button onClick={halt}>Stop</button>}
      </div>
      {positions < 0 && (
        <div className="banner error">§ 마커 개수가 맞지 않습니다.</div>
      )}
      {error && <div className="banner error">{error}</div>}

      <div className="intruder-split">
        <div className="intruder-left">
          <h4>Request template</h4>
          <textarea
            ref={editorRef}
            aria-label="request template"
            className="intruder-editor mono"
            spellCheck={false}
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
          />
          <h4>
            Payload sets{' '}
            <span className="muted">
              {ATTACK_TYPES.find((t) => t.value === attackType)?.hint}
            </span>
          </h4>
          <div className="payload-sets">
            {payloadText.map((text, index) => (
              <textarea
                key={index}
                aria-label={`payload set ${index + 1}`}
                className="payload-input mono"
                placeholder={`set ${index + 1} (한 줄에 하나)`}
                value={text}
                onChange={(e) =>
                  setPayloadText((prev) =>
                    prev.map((t, i) => (i === index ? e.target.value : t)),
                  )
                }
              />
            ))}
          </div>
        </div>

        <div className="intruder-results">
          <div className="results-header">
            {attack ? (
              <span className="mono">
                {attack.status} · {attack.completed}/{attack.total}
              </span>
            ) : (
              <span className="muted">공격을 시작하면 결과가 표시됩니다.</span>
            )}
          </div>
          <table className="flow-table">
            <thead>
              <tr>
                <th className="col-method">#</th>
                <th>Payload</th>
                <th className="col-status">Status</th>
                <th className="col-size">Length</th>
                <th className="col-time">Time</th>
              </tr>
            </thead>
            <tbody>
              {(attack?.results ?? []).map((result) => (
                <tr
                  key={result.index}
                  className={outliers.has(result.index) ? 'outlier' : undefined}
                >
                  <td className="mono num">{result.index}</td>
                  <td className="mono">{result.payloads.join(' , ')}</td>
                  <td className="mono">
                    {result.error ? 'ERR' : result.status_code}
                  </td>
                  <td className="mono num">{result.length}</td>
                  <td className="mono num">
                    {result.duration_ms === null
                      ? ''
                      : `${Math.round(result.duration_ms)} ms`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

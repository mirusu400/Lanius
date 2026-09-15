import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  getAttack,
  startAttack,
  stopAttack,
  type AttackConfig,
} from '../api/client';
import { connectStream } from '../api/stream';
import type { Attack, AttackResult, AttackType } from '../api/types';
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
import { ContextMenu, useContextMenu } from '../components/ContextMenu';
import { useCodegenMenu } from '../components/useCodegenMenu';
import { toSendPayload } from './repeaterModel';
import { useEditorMenu } from '../components/useEditorMenu';
import { sendToRepeater } from './repeaterStore';
import { getFlow } from '../api/client';
import { errorMessage, renderMessage, useT, type Message } from '../i18n';

const DEFAULT_TEMPLATE = 'GET /?q=\u00a7test\u00a7 HTTP/1.1\nHost: example.com\n\n';

export function IntruderTab() {
  const t = useT();
  const [url, setUrl] = useState('http://example.com');
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE);
  const [attackType, setAttackType] = useState<AttackType>('sniper');
  const [payloadText, setPayloadText] = useState(['a\nb\nc']);
  const [attack, setAttack] = useState<Attack | null>(null);
  const [error, setError] = useState<Message | null>(null);

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

  // Right-clicking the template is the natural way to mark a payload
  // position, so the menu offers it alongside the editing actions.
  const codegen = useCodegenMenu();
  // The template carries payload markers, which are not part of the
  // request. They are stripped first, so the generated code is the
  // request as it would be sent with an empty payload rather than one
  // with stray section signs in it.
  const codegenTarget = () => {
    try {
      const payload = toSendPayload(url, clearMarkers(template));
      return {
        url: payload.url,
        method: payload.method,
        headers: payload.headers,
        body: payload.body,
      };
    } catch {
      return null;
    }
  };

  const editorMenu = useEditorMenu(
    [
      {
        label: t('intruder.addMarker'),
        needsSelection: true,
        onSelect: (_selection, editor) =>
          setTemplate(
            addMarker(template, editor.selectionStart, editor.selectionEnd),
          ),
      },
      {
        label: t('intruder.clearMarkers'),
        onSelect: () => setTemplate(clearMarkers(template)),
      },
    ],
    [codegen.buildMenu(codegenTarget())],
  );
  const editorRef = editorMenu.ref;

  // Remembered as the selection is made. Pressing a button moves focus,
  // and a webview may collapse the textarea's selection before the click
  // handler runs, which left the button doing nothing at all.
  const selectionRef = useRef({ start: 0, end: 0 });

  const rememberSelection = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (editor.selectionEnd > editor.selectionStart) {
      selectionRef.current = {
        start: editor.selectionStart,
        end: editor.selectionEnd,
      };
    }
  }, [editorRef]);

  // Also watch the document: React's onSelect does not fire for every way
  // a selection can be made, and this is the event the platform itself
  // raises whenever it changes.
  useEffect(() => {
    document.addEventListener('selectionchange', rememberSelection);
    return () =>
      document.removeEventListener('selectionchange', rememberSelection);
  }, [rememberSelection]);

  const mark = () => {
    const editor = editorRef.current;
    if (!editor) return;
    // Prefer a live selection; fall back to the last one seen.
    const live = editor.selectionEnd > editor.selectionStart;
    const { start, end } = live
      ? { start: editor.selectionStart, end: editor.selectionEnd }
      : selectionRef.current;
    if (end <= start) return;
    setTemplate(addMarker(template, start, end));
    selectionRef.current = { start: 0, end: 0 };
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
      setError(errorMessage(err));
    }
  };

  const halt = async () => {
    if (!attack) return;
    await stopAttack(attack.id);
    void refresh(attack.id);
  };

  const menu = useContextMenu<AttackResult>();

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
          aria-label={t('intruder.targetUrl')}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <select
          aria-label={t('intruder.attackType')}
          value={attackType}
          onChange={(e) => setAttackType(e.target.value as AttackType)}
        >
          {ATTACK_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <button onClick={mark}>{t('intruder.addMarker')}</button>
        <button onClick={() => setTemplate(clearMarkers(template))}>
          {t('intruder.clearMarkers')}
        </button>
        <span className="spacer" />
        <span className="muted">
          {positions < 0
            ? t('intruder.positionsError')
            : t('intruder.positions', {
                count: positions,
                requests: estimate,
              })}
        </span>
        <button className="send" onClick={launch} disabled={running}>
          {running ? t('intruder.attacking') : t('intruder.start')}
        </button>
        {running && <button onClick={halt}>{t('intruder.stop')}</button>}
      </div>
      {positions < 0 && (
        <div className="banner error">{t('intercept.unbalancedMarker')}</div>
      )}
      {error && <div className="banner error">{renderMessage(error, t)}</div>}

      <div className="intruder-split">
        <div className="intruder-left">
          <h4>{t('intruder.template')}</h4>
          <textarea
            ref={editorRef}
            aria-label={t('intruder.templateLabel')}
            className="intruder-editor mono"
            spellCheck={false}
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            onContextMenu={editorMenu.open}
            onSelect={rememberSelection}
            onKeyUp={rememberSelection}
            onMouseUp={rememberSelection}
          />
          {editorMenu.element}
          <h4>
            {t('intruder.payloadSets')}{' '}
            <span className="muted">
              {(() => {
                const hint = ATTACK_TYPES.find(
                  (type) => type.value === attackType,
                )?.hint;
                return hint ? t(hint) : '';
              })()}
            </span>
          </h4>
          <div className="payload-sets">
            {payloadText.map((text, index) => (
              <textarea
                key={index}
                aria-label={t('intruder.payloadSet', { index: index + 1 })}
                className="payload-input mono"
                placeholder={t('intruder.payloadPlaceholder', {
                  index: index + 1,
                })}
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
              <span className="muted">{t('intruder.noResults')}</span>
            )}
          </div>
          <table className="flow-table">
            <thead>
              <tr>
                <th className="col-method">#</th>
                <th>{t('intruder.payload')}</th>
                <th className="col-status">{t('flow.status')}</th>
                <th className="col-size">{t('intruder.length')}</th>
                <th className="col-time">{t('flow.time')}</th>
              </tr>
            </thead>
            <tbody>
              {(attack?.results ?? []).map((result) => (
                <tr
                  key={result.index}
                  className={outliers.has(result.index) ? 'outlier' : undefined}
                  onContextMenu={(event) => menu.open(event, result)}
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
          <ContextMenu
            position={menu.position}
            items={
              menu.target
                ? [
                    {
                      label: t('menu.sendToRepeater'),
                      // A result only carries a flow id, so the request
                      // has to be fetched before it can be resent.
                      disabled: !menu.target.flow_id,
                      onSelect: () => {
                        const id = menu.target?.flow_id;
                        if (!id) return;
                        void getFlow(id)
                          .then((detail) => sendToRepeater(detail, detail))
                          .catch(() => undefined);
                      },
                    },
                    {
                      label: t('menu.copyPayload'),
                      separator: true,
                      onSelect: () => {
                        void navigator.clipboard?.writeText(
                          (menu.target?.payloads ?? []).join(', '),
                        );
                      },
                    },
                  ]
                : []
            }
            onClose={menu.close}
          />
        </div>
      </div>
    </div>
  );
}

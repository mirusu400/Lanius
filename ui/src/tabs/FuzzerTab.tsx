import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  getRun,
  startRun,
  stopRun,
  type RunConfig,
} from '../api/client';
import { connectStream } from '../api/stream';
import type { FuzzRun, RunResult, RunMode } from '../api/types';
import {
  RUN_MODES,
  addMarker,
  clearMarkers,
  countPositions,
  estimateRequests,
  markOutliers,
  parsePayloads,
  requiredSets,
} from './fuzzerModel';
import { subscribeTarget } from './fuzzerStore';
import { ContextMenu, useContextMenu } from '../components/ContextMenu';
import { useCodegenMenu } from '../components/useCodegenMenu';
import { toSendPayload } from './replayModel';
import { PayloadPicker } from '../components/PayloadPicker';
import { RequestEditor } from '../components/RequestEditor';
import { Split } from '../components/Split';
import { ResponseInspector } from '../components/ResponseInspector';
import { formatMessageBody, minify, splitMessage } from '../components/bodyFormat';
import { useEditorMenu } from '../components/useEditorMenu';
import { usePluginActions } from '../components/usePluginActions';
import { sendToReplay } from './replayStore';
import { getFlow } from '../api/client';
import { errorMessage, rawMsg, renderMessage, useT, type Message } from '../i18n';
import { ResizableFillCell, ResizableFillHeader, ResizableHeader, ResizableTable, useResizableColumns } from '../components/ResizableColumns';
import { useShortcut } from '../useShortcut';

const DEFAULT_TEMPLATE = 'GET /?q={{test}} HTTP/1.1\nHost: example.com\n\n';

export function FuzzerTab() {
  const t = useT();
  const resultColumns = useResizableColumns('lanius.columns.fuzzer', [70, 340, 85, 90, 110]);
  const [url, setUrl] = useState('http://example.com');
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE);
  const [mode, setRunMode] = useState<RunMode>('single_position');
  const [payloadText, setPayloadText] = useState(['a\nb\nc']);
  const [run, setRun] = useState<FuzzRun | null>(null);
  const [selectedResultIndex, setSelectedResultIndex] = useState<number | null>(null);
  // How hard to push. Gentle by default: a run that knocks a service
  // over tells you nothing.
  const [concurrency, setConcurrency] = useState(5);
  const [delay, setDelay] = useState(0);
  const [error, setError] = useState<Message | null>(null);

  const runIdRef = useRef<string | null>(null);
  const lastTargetSeq = useRef(0);

  useEffect(
    () =>
      subscribeTarget((target) => {
        // Activity reconnects this subscription when the tab is shown again.
        // The store replays its last target then; keep this tab's current draft
        // and results unless another request was actually sent to Fuzzer.
        if (!target || target.seq === lastTargetSeq.current) return;
        lastTargetSeq.current = target.seq;
        setUrl(target.url);
        setTemplate(target.template);
        setRun(null);
        setSelectedResultIndex(null);
      }),
    [],
  );

  const positions = countPositions(template);
  const sets = useMemo(
    () => payloadText.map((text) => parsePayloads(text)),
    [payloadText],
  );
  const needed = requiredSets(mode, Math.max(positions, 0));
  const estimate =
    positions > 0 ? estimateRequests(mode, positions, sets) : 0;

  // Keep the payload set count in step with the run type / positions.
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
      setRun(await getRun(id));
    } catch {
      /* run may not exist yet */
    }
  }, []);

  useEffect(
    () =>
      connectStream({
        onEvent: (event) => {
          if (
            event.type !== 'fuzzer.result' &&
            event.type !== 'fuzzer.finished'
          ) {
            return;
          }
          const id = runIdRef.current;
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
  // with stray marker braces in it.
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
  const pluginActions = usePluginActions((message) => setError(rawMsg(message)));
  const pluginMenu = pluginActions.buildMenu(
    ['fuzzer', 'request'],
    {
      url,
      raw_request: template,
      request: codegenTarget(),
      run_mode: mode,
      payload_sets: sets,
    },
  );

  const editorMenu = useEditorMenu(
    [
      {
        label: t('fuzzer.addMarker'),
        needsSelection: true,
        onSelect: (_selection, editor) =>
          setTemplate(
            addMarker(template, editor.selectionStart, editor.selectionEnd),
          ),
      },
      {
        label: t('fuzzer.clearMarkers'),
        onSelect: () => setTemplate(clearMarkers(template)),
      },
      // Rewrites the template rather than changing how it is shown, so
      // it is an action you ask for and can undo.
      {
        label: t('body.format'),
        onSelect: (_selection, editor) => {
          const next = formatMessageBody(editor.value, 'pretty');
          if (next !== editor.value) setTemplate(next);
        },
      },
      {
        label: t('body.minify'),
        onSelect: (_selection, editor) => {
          const { head, separator, body } = splitMessage(editor.value);
          if (!separator) return;
          const next = `${head}${separator}${minify(body)}`;
          if (next !== editor.value) setTemplate(next);
        },
      },
    ],
    [
      codegen.buildMenu(codegenTarget()),
      ...(pluginMenu ? [pluginMenu] : []),
    ],
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
    const config: RunConfig = {
      url,
      template,
      mode: mode,
      payload_sets: sets,
      concurrency,
      delay,
    };
    try {
      const started = await startRun(config);
      runIdRef.current = started.id;
      setRun({ ...started, results: [] });
      setSelectedResultIndex(null);
      void refresh(started.id);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const halt = async () => {
    if (!run) return;
    await stopRun(run.id);
    void refresh(run.id);
  };

  const menu = useContextMenu<RunResult>();

  const outliers = useMemo(
    () => markOutliers(run?.results ?? []),
    [run],
  );
  const running = run?.status === 'running' || run?.status === 'pending';
  const selectedResult = run?.results.find((result) => result.index === selectedResultIndex) ?? null;

  const sendResultToReplay = (id: string | null | undefined) => {
    if (!id) return;
    void getFlow(id)
      .then((detail) => sendToReplay(detail, detail))
      .catch((err) => setError(errorMessage(err)));
  };
  useShortcut('request.sendToReplay', () => {
    sendResultToReplay(selectedResult?.flow_id);
  }, Boolean(selectedResult?.flow_id));

  return (
    <div className="fuzzer-tab">
      <div className="fuzzer-controls">
        <input
          className="target"
          aria-label={t('fuzzer.targetUrl')}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <select
          aria-label={t('fuzzer.mode')}
          value={mode}
          onChange={(e) => setRunMode(e.target.value as RunMode)}
        >
          {RUN_MODES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <button onClick={mark}>{t('fuzzer.addMarker')}</button>
        <button onClick={() => setTemplate(clearMarkers(template))}>
          {t('fuzzer.clearMarkers')}
        </button>

        {/* How hard to push. A fixed rate suits neither a load test nor
            a target that falls over at three requests a second. */}
        <label className="speed-field">
          {t('fuzzer.concurrency')}
          <input
            type="number"
            min={1}
            max={64}
            value={concurrency}
            disabled={running}
            onChange={(e) =>
              setConcurrency(
                Math.min(64, Math.max(1, Number(e.target.value) || 1)),
              )
            }
          />
        </label>
        <label className="speed-field">
          {t('fuzzer.delay')}
          <input
            type="number"
            min={0}
            max={60}
            step={0.1}
            value={delay}
            disabled={running}
            onChange={(e) =>
              setDelay(Math.min(60, Math.max(0, Number(e.target.value) || 0)))
            }
          />
        </label>

        <span className="spacer" />
        <span className="muted">
          {positions < 0
            ? t('fuzzer.positionsError')
            : t('fuzzer.positions', {
                count: positions,
                requests: estimate,
              })}
        </span>
        <button className="send" onClick={launch} disabled={running}>
          {running ? t('fuzzer.running') : t('fuzzer.start')}
        </button>
        {running && <button onClick={halt}>{t('fuzzer.stop')}</button>}
      </div>
      {positions < 0 && (
        <div className="banner error">{t('intercept.unbalancedMarker')}</div>
      )}
      {error && <div className="banner error">{renderMessage(error, t)}</div>}

      <Split
        direction="horizontal"
        storageKey="lanius.split.fuzzer"
        initial={0.46}
        className="fuzzer-split"
        first={<div className="fuzzer-left">
          <h4>{t('fuzzer.template')}</h4>
          <RequestEditor
            editorRef={editorRef}
            label={t('fuzzer.templateLabel')}
            className="fuzzer-editor mono"
            value={template}
            onChange={setTemplate}
            onContextMenu={editorMenu.open}
            onSelectionChange={rememberSelection}
          />
          {editorMenu.element}
          <h4>
            {t('fuzzer.payloadSets')}{' '}
            <span className="muted">
              {(() => {
                const hint = RUN_MODES.find(
                  (type) => type.value === mode,
                )?.hint;
                return hint ? t(hint) : '';
              })()}
            </span>
          </h4>
          <div className="payload-sets">
            {payloadText.map((text, index) => (
              <PayloadPicker
                key={index}
                index={index}
                value={text}
                onChange={(next) =>
                  setPayloadText((prev) =>
                    prev.map((existing, i) => (i === index ? next : existing)),
                  )
                }
              />
            ))}
          </div>
        </div>}
        second={<div className="fuzzer-results">
          <div className="results-header">
            {run ? (
              <span className="mono">
                {run.status} · {run.completed}/{run.total}
              </span>
            ) : (
              <span className="muted">{t('fuzzer.noResults')}</span>
            )}
          </div>
          <Split
            direction="vertical"
            storageKey="lanius.split.fuzzer.response"
            initial={0.55}
            className="fuzzer-response-split"
            first={<div className="fuzzer-results-list">
              <ResizableTable columns={resultColumns} className="flow-table">
                <thead>
                  <tr>
                    {['#', t('fuzzer.payload'), t('flow.status'), t('fuzzer.length'), t('flow.time')].map((label, index) => (
                      <ResizableHeader key={index} label={label} index={index} columns={resultColumns} resizeLabel={t('table.resizeColumn', { column: label })} />
                    ))}
                    <ResizableFillHeader />
                  </tr>
                </thead>
                <tbody>
                  {(run?.results ?? []).map((result) => (
                    <tr
                      key={result.index}
                      className={[outliers.has(result.index) ? 'outlier' : '', selectedResultIndex === result.index ? 'selected' : ''].filter(Boolean).join(' ') || undefined}
                      aria-selected={selectedResultIndex === result.index}
                      tabIndex={0}
                      onClick={() => setSelectedResultIndex(result.index)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setSelectedResultIndex(result.index);
                        }
                      }}
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
                      <ResizableFillCell />
                    </tr>
                  ))}
                </tbody>
              </ResizableTable>
            </div>}
            second={<ResponseInspector
              flowId={selectedResult?.flow_id ?? null}
              title={selectedResult ? `${t('detail.response')} #${selectedResult.index}` : undefined}
              empty={selectedResult?.error ?? t('fuzzer.selectResult')}
            />}
          />
          <ContextMenu
            position={menu.position}
            items={
              menu.target
                ? [
                    {
                      label: t('menu.sendToReplay'),
                      shortcutId: 'request.sendToReplay',
                      // A result only carries a flow id, so the request
                      // has to be fetched before it can be resent.
                      disabled: !menu.target.flow_id,
                      onSelect: () => {
                        sendResultToReplay(menu.target?.flow_id);
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
        </div>}
      />
    </div>
  );
}

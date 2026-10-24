import { useCallback, useEffect, useMemo, useState } from 'react';

import { decodeChain, listCodecs } from '../api/client';
import { useT } from '../i18n';
import {
  decoderTabTitle,
  looksBinary,
  toHexDump,
  type DecoderTabState,
} from './decoderModel';
import {
  addDecoderTab,
  getActiveId,
  getDecoderTabs,
  patchDecoderTab,
  removeDecoderTab,
  setActiveId,
  subscribe,
} from './decoderStore';
import { UndoableInput, UndoableTextarea } from '../components/UndoableText';
import { notifyClipboardError, writeClipboardTextWithFeedback } from '../clipboard';

interface StepOutput {
  codec: string;
  direction: string;
  value: string;
}

interface DecodeResult extends Pick<DecoderTabState, 'id' | 'input' | 'steps'> {
  outputs: StepOutput[];
  error: string | null;
}

export function DecoderTab() {
  const t = useT();
  // Tabs live in a store so switching to another tab of the app does not
  // discard every payload.
  const [tabs, setTabs] = useState<DecoderTabState[]>(getDecoderTabs);
  const [activeId, setCurrentId] = useState(getActiveId);

  useEffect(
    () =>
      subscribe((next, id) => {
        setTabs(next);
        setCurrentId(id);
      }),
    [],
  );
  const [result, setResult] = useState<DecodeResult | null>(null);
  const [codecs, setCodecs] = useState<string[]>([]);
  const [hashes, setHashes] = useState<string[]>([]);

  const active = useMemo(
    () => tabs.find((tab) => tab.id === activeId) ?? tabs[0],
    [tabs, activeId],
  );

  const patchActive = useCallback(
    (patch: Partial<DecoderTabState>) => patchDecoderTab(active.id, patch),
    [active.id],
  );

  useEffect(() => {
    listCodecs()
      .then((data) => {
        setCodecs(data.codecs);
        setHashes(data.hashes);
      })
      .catch(() => undefined);
  }, []);

  const { input, steps } = active;
  const matches = result?.id === active.id && result.input === input && result.steps === steps;
  const outputs = matches ? result.outputs : [];
  const error = matches ? result.error : null;

  useEffect(() => {
    let current = true;
    if (steps.length === 0) return;
    const request = { id: active.id, input, steps };
    void decodeChain(input, steps).then((data) => {
      if (current) setResult({ ...request, outputs: data.steps, error: null });
    }).catch((err: unknown) => {
      if (current) setResult({ ...request, outputs: [], error: (err as Error).message });
    });
    return () => { current = false; };
  }, [active.id, input, steps]);

  const all = [...codecs, ...hashes];
  const finalValue = outputs.length > 0 ? outputs[outputs.length - 1].value : input;
  const binary = looksBinary(finalValue);
  const view = active.view;
  const copyResult = async () => {
    try {
      await writeClipboardTextWithFeedback(
        finalValue,
        t('decoder.copied'),
      );
    } catch (copyError) {
      notifyClipboardError(copyError);
    }
  };

  return (
    <div className="decoder-tab">
      <div className="subtabs decoder-tabs">
        {tabs.map((tab) => (
          <span
            key={tab.id}
            className={tab.id === active.id ? 'subtab active' : 'subtab'}
          >
            <button onClick={() => setActiveId(tab.id)}>
              {decoderTabTitle(tab, t('decoder.untitled'))}
            </button>
            <button
              className="close"
              aria-label={t('decoder.closeTab', {
                title: decoderTabTitle(tab, t('decoder.untitled')),
              })}
              onClick={() => removeDecoderTab(tab.id)}
            >
              ×
            </button>
          </span>
        ))}
        <button
          className="new-tab"
          aria-label={t('decoder.newTab')}
          onClick={() => addDecoderTab()}
        >
          +
        </button>
      </div>

      <div className="decoder-controls">
        <button
          onClick={() =>
            patchActive({
              steps: [...steps, { codec: all[0] ?? 'base64', direction: 'decode' }],
            })
          }
        >
          {t('decoder.addStep')}
        </button>
        <button onClick={() => patchActive({ steps: [] })}>{t('common.reset')}</button>
        <UndoableInput
          className="decoder-name"
          aria-label={t('decoder.tabName')}
          placeholder={t('decoder.untitled')}
          value={active.title}
          historyKey={`${active.id}:title`}
          onValueChange={(value) => patchActive({ title: value, renamed: true })}
        />
        <span className="muted">{t('decoder.chainSteps', { count: steps.length })}</span>
      </div>
      {error && <div className="banner error">{error}</div>}

      <div className="decoder-body">
        <label className="field">
          <span className="muted">{t('decoder.input')}</span>
          <UndoableTextarea
            aria-label={t('decoder.inputLabel')}
            className="mono"
            spellCheck={false}
            value={input}
            historyKey={`${active.id}:input`}
            onValueChange={(value) => patchActive({ input: value })}
          />
        </label>

        {steps.map((step, index) => (
          <div className="chain-step" key={index}>
            <div className="chain-controls">
              <select
                aria-label={t('decoder.codec', { index: index + 1 })}
                value={step.codec}
                onChange={(e) =>
                  patchActive({
                    steps: steps.map((s, i) =>
                      i === index ? { ...s, codec: e.target.value } : s,
                    ),
                  })
                }
              >
                {all.map((codec) => (
                  <option key={codec} value={codec}>
                    {codec}
                  </option>
                ))}
              </select>
              <select
                aria-label={t('decoder.direction', { index: index + 1 })}
                value={step.direction}
                onChange={(e) =>
                  patchActive({
                    steps: steps.map((s, i) =>
                      i === index
                        ? { ...s, direction: e.target.value as 'encode' | 'decode' }
                        : s,
                    ),
                  })
                }
              >
                <option value="decode">decode</option>
                <option value="encode">encode</option>
              </select>
              <button
                aria-label={t('decoder.removeStep', { index: index + 1 })}
                onClick={() =>
                  patchActive({ steps: steps.filter((_, i) => i !== index) })
                }
              >
                ×
              </button>
            </div>
            <pre className="mono chain-output">{outputs[index]?.value ?? ''}</pre>
          </div>
        ))}

        <div className="decoder-result">
          <div className="decoder-result-head">
            <span className="muted">{t('decoder.result')}</span>
            <div className="view-toggle">
              {(['text', 'hex'] as const).map((mode) => (
                <button
                  key={mode}
                  className={view === mode ? 'active' : undefined}
                  onClick={() => patchActive({ view: mode })}
                >
                  {t(`decoder.view${mode === 'text' ? 'Text' : 'Hex'}` as const)}
                </button>
              ))}
            </div>
            {binary && view === 'text' && (
              <span className="muted">{t('decoder.binaryHint')}</span>
            )}
            <button
              onClick={() => void copyResult()}
              disabled={!finalValue}
            >
              {t('decoder.copy')}
            </button>
          </div>
          <pre className="mono decoder-raw">
            {view === 'hex' ? toHexDump(finalValue) : finalValue}
          </pre>
        </div>
      </div>
    </div>
  );
}

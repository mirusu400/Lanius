import { useCallback, useEffect, useMemo, useState } from 'react';

import { decodeChain, listCodecs } from '../api/client';
import { useT } from '../i18n';
import {
  decoderTabTitle,
  emptyDecoderTab,
  looksBinary,
  toHexDump,
  type DecoderTabState,
} from './decoderModel';

interface StepOutput {
  codec: string;
  direction: string;
  value: string;
}

type View = 'text' | 'hex';

export function DecoderTab() {
  const t = useT();
  const [tabs, setTabs] = useState<DecoderTabState[]>(() => [emptyDecoderTab()]);
  const [activeId, setActiveId] = useState(() => tabs[0].id);
  const [outputs, setOutputs] = useState<StepOutput[]>([]);
  const [codecs, setCodecs] = useState<string[]>([]);
  const [hashes, setHashes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>('text');

  const active = useMemo(
    () => tabs.find((tab) => tab.id === activeId) ?? tabs[0],
    [tabs, activeId],
  );

  const patchActive = useCallback(
    (patch: Partial<DecoderTabState>) => {
      setTabs((prev) =>
        prev.map((tab) => (tab.id === active.id ? { ...tab, ...patch } : tab)),
      );
    },
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

  const run = useCallback(async () => {
    if (steps.length === 0) {
      setOutputs([]);
      setError(null);
      return;
    }
    try {
      const data = await decodeChain(input, steps);
      setOutputs(data.steps);
      setError(null);
    } catch (err) {
      setOutputs([]);
      setError((err as Error).message);
    }
  }, [input, steps]);

  useEffect(() => {
    void run();
  }, [run]);

  const all = [...codecs, ...hashes];
  const finalValue = outputs.length > 0 ? outputs[outputs.length - 1].value : input;
  const binary = looksBinary(finalValue);

  const closeTab = (id: string) => {
    setTabs((prev) => {
      const next = prev.filter((tab) => tab.id !== id);
      // Never leave the tab with nothing to show.
      const result = next.length > 0 ? next : [emptyDecoderTab()];
      if (id === activeId) setActiveId(result[result.length - 1].id);
      return result;
    });
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
              onClick={() => closeTab(tab.id)}
            >
              ×
            </button>
          </span>
        ))}
        <button
          className="new-tab"
          aria-label={t('decoder.newTab')}
          onClick={() => {
            const tab = emptyDecoderTab();
            setTabs((prev) => [...prev, tab]);
            setActiveId(tab.id);
          }}
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
        <input
          className="decoder-name"
          aria-label={t('decoder.tabName')}
          placeholder={t('decoder.untitled')}
          value={active.title}
          onChange={(e) => patchActive({ title: e.target.value, renamed: true })}
        />
        <span className="muted">{t('decoder.chainSteps', { count: steps.length })}</span>
      </div>
      {error && <div className="banner error">{error}</div>}

      <div className="decoder-body">
        <label className="field">
          <span className="muted">{t('decoder.input')}</span>
          <textarea
            aria-label={t('decoder.inputLabel')}
            className="mono"
            spellCheck={false}
            value={input}
            onChange={(e) => patchActive({ input: e.target.value })}
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
                  onClick={() => setView(mode)}
                >
                  {t(`decoder.view${mode === 'text' ? 'Text' : 'Hex'}` as const)}
                </button>
              ))}
            </div>
            {binary && view === 'text' && (
              <span className="muted">{t('decoder.binaryHint')}</span>
            )}
            <button
              onClick={() => void navigator.clipboard?.writeText(finalValue)}
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

import { useCallback, useEffect, useState } from 'react';

import { decodeChain, listCodecs, type ChainStep } from '../api/client';
import { useT } from '../i18n';

interface StepOutput {
  codec: string;
  direction: string;
  value: string;
}

export function DecoderTab() {
  const t = useT();
  const [input, setInput] = useState('');
  const [steps, setSteps] = useState<ChainStep[]>([]);
  const [outputs, setOutputs] = useState<StepOutput[]>([]);
  const [codecs, setCodecs] = useState<string[]>([]);
  const [hashes, setHashes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listCodecs()
      .then((data) => {
        setCodecs(data.codecs);
        setHashes(data.hashes);
      })
      .catch(() => undefined);
  }, []);

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

  return (
    <div className="decoder-tab">
      <div className="decoder-controls">
        <button
          onClick={() =>
            setSteps((prev) => [
              ...prev,
              { codec: all[0] ?? 'base64', direction: 'decode' },
            ])
          }
        >
          {t('decoder.addStep')}
        </button>
        <button onClick={() => setSteps([])}>{t('common.reset')}</button>
        <span className="muted">
          {t('decoder.chainSteps', { count: steps.length })}
        </span>
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
            onChange={(e) => setInput(e.target.value)}
          />
        </label>

        {steps.map((step, index) => (
          <div className="chain-step" key={index}>
            <div className="chain-controls">
              <select
                aria-label={t('decoder.codec', { index: index + 1 })}
                value={step.codec}
                onChange={(e) =>
                  setSteps((prev) =>
                    prev.map((s, i) =>
                      i === index ? { ...s, codec: e.target.value } : s,
                    ),
                  )
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
                  setSteps((prev) =>
                    prev.map((s, i) =>
                      i === index
                        ? {
                            ...s,
                            direction: e.target.value as 'encode' | 'decode',
                          }
                        : s,
                    ),
                  )
                }
              >
                <option value="decode">decode</option>
                <option value="encode">encode</option>
              </select>
              <button
                aria-label={t('decoder.removeStep', { index: index + 1 })}
                onClick={() =>
                  setSteps((prev) => prev.filter((_, i) => i !== index))
                }
              >
                ×
              </button>
            </div>
            <pre className="mono chain-output">
              {outputs[index]?.value ?? ''}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}

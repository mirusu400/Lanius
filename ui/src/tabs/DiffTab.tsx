import { useState } from 'react';

import { compareTexts, type CompareBlock } from '../api/client';
import { useT } from '../i18n';
import { Split } from '../components/Split';

interface Result {
  blocks: CompareBlock[];
  added: number;
  removed: number;
  similarity: number;
  identical: boolean;
}

export function DiffTab() {
  const t = useT();
  const [left, setLeft] = useState('');
  const [right, setRight] = useState('');
  const [mode, setMode] = useState<'word' | 'byte'>('word');
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    try {
      setResult(await compareTexts(left, right, mode));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="diff-tab">
      <div className="diff-controls">
        <select
          aria-label={t('diff.mode')}
          value={mode}
          onChange={(e) => setMode(e.target.value as 'word' | 'byte')}
        >
          <option value="word">{t('diff.word')}</option>
          <option value="byte">{t('diff.byte')}</option>
        </select>
        <button className="send" onClick={() => void run()}>
          {t('diff.compare')}
        </button>
        {result && (
          <span className="muted mono">
            {result.identical
              ? t('diff.identical')
              : t('diff.summary', {
                  added: result.added,
                  removed: result.removed,
                  percent: (result.similarity * 100).toFixed(1),
                })}
          </span>
        )}
      </div>
      {error && <div className="banner error">{error}</div>}

      <Split
        direction="horizontal"
        storageKey="lanius.split.diff"
        className="diff-inputs"
        first={<textarea
          aria-label={t('diff.left')}
          className="mono"
          spellCheck={false}
          placeholder={t('diff.leftPlaceholder')}
          value={left}
          onChange={(e) => setLeft(e.target.value)}
        />}
        second={<textarea
          aria-label={t('diff.right')}
          className="mono"
          spellCheck={false}
          placeholder={t('diff.rightPlaceholder')}
          value={right}
          onChange={(e) => setRight(e.target.value)}
        />}
      />

      {result && (
        <div className="diff mono" data-testid="diff">
          {result.blocks.map((block, index) => (
            <span key={index} className={`diff-${block.tag}`}>
              {block.tag === 'insert'
                ? block.right
                : block.tag === 'replace'
                  ? `${block.left}\u2192${block.right}`
                  : block.left}{' '}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

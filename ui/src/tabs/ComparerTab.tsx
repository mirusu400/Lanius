import { useState } from 'react';

import { compareTexts, type CompareBlock } from '../api/client';
import { useT } from '../i18n';

interface Result {
  blocks: CompareBlock[];
  added: number;
  removed: number;
  similarity: number;
  identical: boolean;
}

export function ComparerTab() {
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
    <div className="comparer-tab">
      <div className="comparer-controls">
        <select
          aria-label={t('comparer.mode')}
          value={mode}
          onChange={(e) => setMode(e.target.value as 'word' | 'byte')}
        >
          <option value="word">{t('comparer.word')}</option>
          <option value="byte">{t('comparer.byte')}</option>
        </select>
        <button className="send" onClick={() => void run()}>
          {t('comparer.compare')}
        </button>
        {result && (
          <span className="muted mono">
            {result.identical
              ? t('comparer.identical')
              : t('comparer.summary', {
                  added: result.added,
                  removed: result.removed,
                  percent: (result.similarity * 100).toFixed(1),
                })}
          </span>
        )}
      </div>
      {error && <div className="banner error">{error}</div>}

      <div className="comparer-inputs">
        <textarea
          aria-label={t('comparer.left')}
          className="mono"
          spellCheck={false}
          placeholder={t('comparer.leftPlaceholder')}
          value={left}
          onChange={(e) => setLeft(e.target.value)}
        />
        <textarea
          aria-label={t('comparer.right')}
          className="mono"
          spellCheck={false}
          placeholder={t('comparer.rightPlaceholder')}
          value={right}
          onChange={(e) => setRight(e.target.value)}
        />
      </div>

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

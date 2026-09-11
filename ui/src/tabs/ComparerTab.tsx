import { useState } from 'react';

import { compareTexts, type CompareBlock } from '../api/client';

interface Result {
  blocks: CompareBlock[];
  added: number;
  removed: number;
  similarity: number;
  identical: boolean;
}

export function ComparerTab() {
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
          aria-label="compare mode"
          value={mode}
          onChange={(e) => setMode(e.target.value as 'word' | 'byte')}
        >
          <option value="word">단어 단위</option>
          <option value="byte">바이트 단위</option>
        </select>
        <button className="send" onClick={() => void run()}>
          Compare
        </button>
        {result && (
          <span className="muted mono">
            {result.identical
              ? '동일'
              : `+${result.added} / -${result.removed} · 유사도 ${(
                  result.similarity * 100
                ).toFixed(1)}%`}
          </span>
        )}
      </div>
      {error && <div className="banner error">{error}</div>}

      <div className="comparer-inputs">
        <textarea
          aria-label="left text"
          className="mono"
          spellCheck={false}
          placeholder="왼쪽"
          value={left}
          onChange={(e) => setLeft(e.target.value)}
        />
        <textarea
          aria-label="right text"
          className="mono"
          spellCheck={false}
          placeholder="오른쪽"
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

import type { RefObject } from 'react';

import { useT } from '../i18n';
import { UndoableInput } from './UndoableText';

export type MessageSearchMode = 'find' | 'replace';

export function MessageSearchToggles({
  pane,
  mode,
  onFind,
  onReplace,
  replace = false,
}: {
  pane: string;
  mode: MessageSearchMode | null;
  onFind: () => void;
  onReplace?: () => void;
  replace?: boolean;
}) {
  const t = useT();
  return <div className="message-search-toggles">
    <button
      type="button"
      className="message-search-toggle"
      onClick={onFind}
      aria-label={t('detail.findIn', { pane })}
      title={t('detail.findShortcut')}
      aria-pressed={mode === 'find'}
    >
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="8.5" cy="8.5" r="5" />
        <path d="m12.2 12.2 4.3 4.3" />
      </svg>
    </button>
    {replace && <button
      type="button"
      className="message-search-toggle"
      onClick={onReplace}
      aria-label={t('editor.replaceIn', { pane })}
      title={t('editor.replaceIn', { pane })}
      aria-pressed={mode === 'replace'}
    >
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 14.7 3.5 17l2.3-.5L15.6 6.7l-1.8-1.8L4 14.7Z" />
        <path d="m12.8 5.9 1.8 1.8M4 11H2.8A1.8 1.8 0 0 0 1 12.8v3.4A1.8 1.8 0 0 0 2.8 18h3.4A1.8 1.8 0 0 0 8 16.2V15" />
      </svg>
    </button>}
  </div>;
}

export function MessageSearchBar({
  pane,
  mode,
  query,
  replacement = '',
  inputRef,
  current,
  count,
  onQuery,
  onReplacement,
  onPrevious,
  onNext,
  onReplace,
  onReplaceAll,
  onClose,
}: {
  pane: string;
  mode: MessageSearchMode;
  query: string;
  replacement?: string;
  inputRef: RefObject<HTMLInputElement | null>;
  current: number;
  count: number;
  onQuery: (value: string) => void;
  onReplacement?: (value: string) => void;
  onPrevious: () => void;
  onNext: () => void;
  onReplace?: () => void;
  onReplaceAll?: () => void;
  onClose: () => void;
}) {
  const t = useT();
  return <div className={`detail-find-bar message-search-bar mode-${mode}`}>
    <div className="message-search-row message-search-query-row">
      <UndoableInput
        inputRef={inputRef}
        type="search"
        aria-label={t('detail.findIn', { pane })}
        placeholder={t('detail.findPlaceholder')}
        value={query}
        onValueChange={onQuery}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            (event.shiftKey ? onPrevious : onNext)();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
        }}
      />
      <span className="detail-find-count" aria-live="polite">
        {query ? `${count ? current + 1 : 0}/${count}` : '0/0'}
      </span>
      <button type="button" onClick={onPrevious} disabled={!count} aria-label={t('detail.findPrevious')} title={t('detail.findPrevious')}>
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12 5-5 5 5" /></svg>
      </button>
      <button type="button" onClick={onNext} disabled={!count} aria-label={t('detail.findNext')} title={t('detail.findNext')}>
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 8 5 5 5-5" /></svg>
      </button>
      <button type="button" onClick={onClose} aria-label={t('detail.findClose')} title={t('detail.findClose')}>
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>
      </button>
    </div>
    {mode === 'replace' && <div className="message-search-row message-search-replace-row">
      <UndoableInput
        type="text"
        aria-label={t('editor.replacement')}
        placeholder={t('editor.replacementPlaceholder')}
        value={replacement}
        onValueChange={onReplacement ?? (() => {})}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            onReplace?.();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
        }}
      />
      <button type="button" className="message-search-action" onClick={onReplace} disabled={!count}>{t('editor.replaceCurrent')}</button>
      <button type="button" className="message-search-action" onClick={onReplaceAll} disabled={!count}>{t('editor.replaceAll')}</button>
    </div>}
  </div>;
}

/** A request editor with Pretty, Raw and Hex views.
 *
 * The raw text is the request. Pretty and Hex are ways of reading it,
 * never a change to it: the bytes that go on the wire are always the
 * bytes in the raw view. Formatting used to be applied to the stored
 * text, which meant indentation was inserted into what got sent, and a
 * body checked by length, hash or signature no longer matched.
 *
 * Only Raw is editable, for the same reason. Typing into a laid-out
 * body would have to be folded back into the original, and there is no
 * honest way to do that: whitespace inside a JSON string is meaningful,
 * so the result would sometimes differ from what was typed. Switching to
 * Raw to edit is a smaller surprise than a body that changes by itself.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  canReformat,
  formatMessageBody,
  hexPreview,
  minify,
  splitMessage,
  type BodyView,
} from './bodyFormat';
import { useT } from '../i18n';
import { HighlightedEditor, HighlightedMessage } from './SyntaxCode';
import { messageHeaders } from './syntaxLanguage';
import { CodeDisplayControls } from './CodeDisplayControls';
import { MarkedText } from './MarkedText';
import { findMatches } from './searchHighlight';
import { MessageSearchBar, MessageSearchToggles, type MessageSearchMode } from './MessageSearch';

const VIEWS: BodyView[] = ['pretty', 'raw', 'hex'];

export function RequestEditor({
  value,
  onChange,
  label,
  className,
  highlightClassName,
  editorRef,
  onContextMenu,
  extraControls,
  onSelectionChange,
  historyKey,
  highlightPattern,
  initialView = 'pretty',
  enableFindReplace = false,
}: {
  /** The raw request. Always exactly what will be sent. */
  value: string;
  onChange: (raw: string) => void;
  label: string;
  className?: string;
  highlightClassName?: string;
  editorRef?: React.RefObject<HTMLTextAreaElement | null>;
  onContextMenu?: (event: React.MouseEvent) => void;
  /** Buttons that belong beside the view switch. */
  extraControls?: React.ReactNode;
  /** Fires as the caret moves, for callers that act on a selection. */
  onSelectionChange?: () => void;
  /** A different document must not inherit the previous document's undo stack. */
  historyKey?: string;
  /** A global pattern to emphasize in the Raw and Pretty views. */
  highlightPattern?: RegExp;
  /** Replay opens on Raw so the captured request is immediately editable. */
  initialView?: BodyView;
  /** Add local find and literal match/replace controls. */
  enableFindReplace?: boolean;
}) {
  const t = useT();
  const [view, setView] = useState<BodyView>(initialView);
  const [showLineEndings, setShowLineEndings] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [searchMode, setSearchMode] = useState<MessageSearchMode | null>(null);
  const [findQuery, setFindQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const localEditorRef = useRef<HTMLTextAreaElement | null>(null);
  const activeEditorRef = editorRef ?? localEditorRef;
  const findInputRef = useRef<HTMLInputElement | null>(null);

  const shown = useMemo(() => {
    if (view === 'raw') return value;
    if (view === 'pretty') return formatMessageBody(value, 'pretty');
    // Hex covers the whole message, headers included: when it is being
    // read at all, it is usually to find a byte the eye cannot see.
    return hexPreview(value).text;
  }, [value, view]);

  const truncated = view === 'hex' ? hexPreview(value).truncated : 0;
  const reformattable = canReformat(splitMessage(value).body);
  const headers = useMemo(() => messageHeaders(value), [value]);
  const query = searchMode ? findQuery : '';
  const matches = useMemo(() => findMatches(shown, query), [query, shown]);
  const currentIndex = matches.length ? activeIndex % matches.length : 0;

  const openSearch = useCallback((mode: MessageSearchMode) => {
    if (mode === 'replace') setView('raw');
    if (searchMode === mode) {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    } else {
      setActiveIndex(0);
      setSearchMode(mode);
    }
  }, [searchMode]);

  useEffect(() => {
    if (!searchMode) return;
    findInputRef.current?.focus();
    findInputRef.current?.select();
  }, [searchMode]);

  useEffect(() => {
    if (!enableFindReplace) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const inside = target instanceof Node && !!rootRef.current?.contains(target);
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        if (event.defaultPrevented || !inside) return;
        event.preventDefault();
        openSearch('find');
      } else if (event.key === 'Escape' && searchMode && inside) {
        event.preventDefault();
        setSearchMode(null);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [enableFindReplace, openSearch, searchMode]);

  useLayoutEffect(() => {
    if (!searchMode || !query || !matches.length) return;
    const mark = rootRef.current?.querySelector<HTMLElement>(`mark[data-find-index="${currentIndex}"]`);
    mark?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    if (view !== 'raw') return;
    const editor = activeEditorRef.current;
    const match = matches[currentIndex];
    if (!editor || !match) return;
    const textareaOffset = (offset: number) => value.slice(0, offset).replace(/\r\n/g, '\n').length;
    editor.setSelectionRange(textareaOffset(match.start), textareaOffset(match.end));
    const overlay = rootRef.current?.querySelector<HTMLElement>('.highlight-editor-overlay');
    if (overlay) {
      editor.scrollTop = overlay.scrollTop;
      editor.scrollLeft = overlay.scrollLeft;
    }
  }, [activeEditorRef, currentIndex, matches, query, searchMode, value, view]);

  const move = (direction: number) => {
    if (matches.length) setActiveIndex((currentIndex + direction + matches.length) % matches.length);
  };

  const replaceCurrent = () => {
    const rawMatches = findMatches(value, findQuery);
    if (!rawMatches.length) return;
    const index = activeIndex % rawMatches.length;
    const match = rawMatches[index];
    const next = value.slice(0, match.start) + replacement + value.slice(match.end);
    onChange(next);
    const following = findMatches(next, findQuery);
    const nextStart = match.start + replacement.length;
    const nextIndex = following.findIndex((candidate) => candidate.start >= nextStart);
    setActiveIndex(nextIndex >= 0 ? nextIndex : 0);
  };

  const replaceAll = () => {
    const rawMatches = findMatches(value, findQuery);
    if (!rawMatches.length) return;
    let cursor = 0;
    let next = '';
    for (const match of rawMatches) {
      next += value.slice(cursor, match.start) + replacement;
      cursor = match.end;
    }
    onChange(next + value.slice(cursor));
    setActiveIndex(0);
  };

  const changeView = (next: BodyView) => {
    setView(next);
    setActiveIndex(0);
    if (searchMode === 'replace' && next !== 'raw') setSearchMode('find');
  };

  return (
    <div className="request-editor" ref={rootRef}>
      <div className="request-editor-bar">
        <CodeDisplayControls showLineEndings={showLineEndings} onShowLineEndings={setShowLineEndings}
          wrap={wrap} onWrap={setWrap} disabled={view === 'hex'} />
        <div className="view-switch" role="tablist" aria-label={t('editor.views')}>
          {VIEWS.map((option) => (
            <button
              key={option}
              role="tab"
              aria-selected={view === option}
              className={view === option ? 'active' : ''}
              onClick={() => changeView(option)}
            >
              {t(`detail.view.${option === 'pretty' ? 'parsed' : option}`)}
            </button>
          ))}
        </div>

        {view !== 'raw' && (
          // Said plainly rather than left to be discovered by typing
          // into a box that ignores you.
          <span className="muted">{t('editor.viewOnly')}</span>
        )}

        {/* Rewriting the body is still useful, but it is an action you
            ask for, not something that happens on open. */}
        {view === 'raw' && reformattable && (
          <button
            type="button"
            className="link-button"
            onClick={() => onChange(formatMessageBody(value, 'pretty'))}
          >
            {t('body.format')}
          </button>
        )}
        {view === 'raw' && splitMessage(value).body.trim() && (
          <button
            type="button"
            className="link-button"
            onClick={() => {
              const { head, separator, body } = splitMessage(value);
              if (separator) onChange(`${head}${separator}${minify(body)}`);
            }}
          >
            {t('body.minify')}
          </button>
        )}

        <span className="spacer" />
        {extraControls}
        {enableFindReplace && <MessageSearchToggles
          pane={label}
          mode={searchMode}
          replace
          onFind={() => openSearch('find')}
          onReplace={() => openSearch('replace')}
        />}
      </div>

      {searchMode && <MessageSearchBar
        pane={label}
        mode={searchMode}
        query={findQuery}
        replacement={replacement}
        inputRef={findInputRef}
        current={currentIndex}
        count={matches.length}
        onQuery={(next) => { setFindQuery(next); setActiveIndex(0); }}
        onReplacement={setReplacement}
        onPrevious={() => move(-1)}
        onNext={() => move(1)}
        onReplace={replaceCurrent}
        onReplaceAll={replaceAll}
        onClose={() => setSearchMode(null)}
      />}

      {view === 'raw' ? (
        <HighlightedEditor
          text={value}
          headers={headers}
          onChange={onChange}
          className={className || 'mono'}
          containerClassName={`request-highlight-editor${highlightClassName ? ` ${highlightClassName}` : ''}`}
          label={label}
          editorRef={activeEditorRef}
          historyKey={historyKey}
          onContextMenu={onContextMenu}
          onSelect={onSelectionChange}
          onKeyUp={onSelectionChange}
          onMouseUp={onSelectionChange}
          showLineEndings={showLineEndings}
          wrap={wrap}
          highlightPattern={highlightPattern}
          query={query}
          activeIndex={searchMode && matches.length ? currentIndex : null}
        />
      ) : (
        <div className="request-editor-view" onContextMenu={onContextMenu}>
          {view === 'pretty'
            ? <HighlightedMessage className={className || ''} text={shown} headers={headers} showLineEndings={showLineEndings} wrap={wrap} highlightPattern={highlightPattern} query={query} activeIndex={searchMode && matches.length ? currentIndex : null} />
            : <pre className={className} data-view={view}><MarkedText text={shown} query={query} activeIndex={searchMode && matches.length ? currentIndex : null} /></pre>}
          {truncated > 0 && (
            <p className="muted">
              {t('detail.hexTruncated', { count: String(truncated) })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

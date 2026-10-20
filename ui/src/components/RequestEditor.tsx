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

import { useMemo, useState } from 'react';

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
}) {
  const t = useT();
  const [view, setView] = useState<BodyView>('pretty');
  const [showLineEndings, setShowLineEndings] = useState(false);
  const [wrap, setWrap] = useState(true);

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

  return (
    <div className="request-editor">
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
              onClick={() => setView(option)}
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
      </div>

      {view === 'raw' ? (
        <HighlightedEditor
          text={value}
          headers={headers}
          onChange={onChange}
          className={className || 'mono'}
          containerClassName={`request-highlight-editor${highlightClassName ? ` ${highlightClassName}` : ''}`}
          label={label}
          editorRef={editorRef}
          historyKey={historyKey}
          onContextMenu={onContextMenu}
          onSelect={onSelectionChange}
          onKeyUp={onSelectionChange}
          onMouseUp={onSelectionChange}
          showLineEndings={showLineEndings}
          wrap={wrap}
        />
      ) : (
        <div className="request-editor-view" onContextMenu={onContextMenu}>
          {view === 'pretty'
            ? <HighlightedMessage className={className || ''} text={shown} headers={headers} showLineEndings={showLineEndings} wrap={wrap} />
            : <pre className={className} data-view={view}>{shown}</pre>}
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

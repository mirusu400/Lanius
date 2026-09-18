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

const VIEWS: BodyView[] = ['pretty', 'raw', 'hex'];

export function RequestEditor({
  value,
  onChange,
  label,
  className,
  editorRef,
  onContextMenu,
  extraControls,
  onSelectionChange,
}: {
  /** The raw request. Always exactly what will be sent. */
  value: string;
  onChange: (raw: string) => void;
  label: string;
  className?: string;
  editorRef?: React.Ref<HTMLTextAreaElement>;
  onContextMenu?: (event: React.MouseEvent) => void;
  /** Buttons that belong beside the view switch. */
  extraControls?: React.ReactNode;
  /** Fires as the caret moves, for callers that act on a selection. */
  onSelectionChange?: () => void;
}) {
  const t = useT();
  const [view, setView] = useState<BodyView>('raw');

  const shown = useMemo(() => {
    if (view === 'raw') return value;
    if (view === 'pretty') return formatMessageBody(value, 'pretty');
    // Hex covers the whole message, headers included: when it is being
    // read at all, it is usually to find a byte the eye cannot see.
    return hexPreview(value).text;
  }, [value, view]);

  const truncated = view === 'hex' ? hexPreview(value).truncated : 0;
  const reformattable = canReformat(splitMessage(value).body);

  return (
    <div className="request-editor">
      <div className="request-editor-bar">
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
        {reformattable && (
          <button
            type="button"
            className="link-button"
            onClick={() => onChange(formatMessageBody(value, 'pretty'))}
          >
            {t('body.format')}
          </button>
        )}
        {splitMessage(value).body.trim() && (
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
        <textarea
          ref={editorRef}
          className={className}
          aria-label={label}
          spellCheck={false}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onContextMenu={onContextMenu}
          onSelect={onSelectionChange}
          onKeyUp={onSelectionChange}
          onMouseUp={onSelectionChange}
        />
      ) : (
        <div className="request-editor-view" onContextMenu={onContextMenu}>
          <pre className={className}>{shown}</pre>
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

import { lazy, Suspense, useMemo, useRef } from 'react';

import hljs from 'highlight.js/lib/core';
import css from 'highlight.js/lib/languages/css';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';

import { splitMessage } from './bodyFormat';
import { bodyLanguage, HIGHLIGHT_LIMIT, type SyntaxHeaders, type SyntaxLanguage } from './syntaxLanguage';
import { markHighlightedHtml } from './searchHighlight';
import { UndoableTextarea } from './UndoableText';
import { LoadingPane } from './Spinner';
import { LARGE_TEXT_THRESHOLD } from './textDocumentModel';
import { loadLargeTextView } from './largeTextViewLoader';
import { selectableTextProps } from './selectAllText';

const LargeTextView = lazy(loadLargeTextView);

// Register only the grammars used by captured HTTP bodies. XML also handles
// HTML and its embedded script/style elements.
hljs.registerLanguage('css', css);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('xml', xml);

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function highlightedHtml(text: string, language: SyntaxLanguage | null): string {
  if (!language || !text || text.length > HIGHLIGHT_LIMIT) return escapeHtml(text);
  // highlight() escapes source markup before adding its own token spans.
  return hljs.highlight(text, { language, ignoreIllegals: true }).value;
}

/** Generated content keeps line-ending labels out of selections and raw bytes.
 * Textareas normalise line endings, so their visual overlay must do the same. */
function withLineEndings(html: string, show: boolean, normalize = false): string {
  if (!show && !normalize) return html;
  return html.replace(/(?:&#13;|\r)\n|&#13;|\r|\n/g, (ending) => {
    const label = ending.endsWith('\n')
      ? ending.length === 1 ? '\\n' : '\\r\\n'
      : '\\r';
    const marker = show ? `<span class="code-line-ending" data-eol="${label}" aria-hidden="true"></span>` : '';
    return marker + (normalize ? '\n' : ending);
  });
}

/** Colour a request target without treating the whole query as one token.
 *
 * Keeping the path as a link makes the request line easy to scan, while
 * distinct key/value colours make dense Replay and History query strings
 * readable. This deliberately works on the encoded target: decoding it here
 * could make an escaped `&` or `=` look like a separator when it is not one.
 */
function requestTargetHtml(target: string): string {
  const question = target.indexOf('?');
  if (question < 0) return `<span class="hljs-link">${escapeHtml(target)}</span>`;

  const path = target.slice(0, question);
  const afterQuestion = target.slice(question + 1);
  const hash = afterQuestion.indexOf('#');
  const query = hash < 0 ? afterQuestion : afterQuestion.slice(0, hash);
  const fragment = hash < 0 ? '' : afterQuestion.slice(hash);
  const params = query.split(/(&)/).map((part) => {
    if (part === '&') return '&amp;';
    const equals = part.indexOf('=');
    const key = equals < 0 ? part : part.slice(0, equals);
    const value = equals < 0 ? null : part.slice(equals + 1);
    return `${key ? `<span class="hljs-attr">${escapeHtml(key)}</span>` : ''}`
      + `${value === null ? '' : `=${value ? `<span class="hljs-string">${escapeHtml(value)}</span>` : ''}`}`;
  }).join('');

  return `<span class="hljs-link">${escapeHtml(path)}</span>?${params}`
    + (fragment ? `<span class="hljs-link">${escapeHtml(fragment)}</span>` : '');
}

function SyntaxFragment({ text, language, query = '', activeIndex = null, offset = 0, showLineEndings = false }: {
  text: string;
  language: SyntaxLanguage | null;
  query?: string;
  activeIndex?: number | null;
  offset?: number;
  showLineEndings?: boolean;
}) {
  const html = useMemo(() => {
    return withLineEndings(markHighlightedHtml(highlightedHtml(text, language), query, activeIndex, offset), showLineEndings);
  }, [text, language, query, activeIndex, offset, showLineEndings]);

  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

function messageHeadHtml(text: string): string {
  return text.split(/(\r?\n)/).map((line, index) => {
    if (index % 2) return escapeHtml(line);

    if (index === 0) {
      const request = line.match(/^([A-Z]+)(\s+)(\S+)(\s+)(HTTP\/\S+)$/);
      if (request) return `<span class="hljs-keyword">${escapeHtml(request[1])}</span>${escapeHtml(request[2])}${requestTargetHtml(request[3])}${escapeHtml(request[4])}<span class="hljs-meta">${escapeHtml(request[5])}</span>`;
      const response = line.match(/^(HTTP(?:\/\S+)?)(\s+)(\d{3})(.*)$/);
      if (response) return `<span class="hljs-meta">${escapeHtml(response[1])}</span>${escapeHtml(response[2])}<span class="hljs-number">${escapeHtml(response[3])}</span>${escapeHtml(response[4])}`;
    }

    const header = line.match(/^([^:\r\n]+)(:)(.*)$/);
    return header
      ? `<span class="hljs-attr">${escapeHtml(header[1])}</span>${escapeHtml(header[2])}${escapeHtml(header[3])}`
      : escapeHtml(line);
  }).join('');
}

function messageHtml(text: string, headers: SyntaxHeaders, responsePath?: string | null, fallbackMime?: string | null): string {
  const { head, separator, body } = splitMessage(text);
  if (!separator) return messageHeadHtml(text);
  const language = bodyLanguage(headers, body, fallbackMime, responsePath);
  return messageHeadHtml(head) + escapeHtml(separator) + highlightedHtml(body, language);
}

/** An editable raw message with inert syntax colours behind the textarea. */
export function HighlightedEditor({ text, onChange, headers, responsePath, className, containerClassName, readOnly = false, label, historyKey, editorRef, onContextMenu, onSelect, onKeyUp, onMouseUp, showLineEndings = false, wrap = true }: {
  text: string;
  onChange: (text: string) => void;
  headers: SyntaxHeaders;
  responsePath?: string | null;
  className: string;
  containerClassName?: string;
  readOnly?: boolean;
  label?: string;
  historyKey?: string;
  editorRef?: React.RefObject<HTMLTextAreaElement | null>;
  onContextMenu?: React.MouseEventHandler<HTMLTextAreaElement>;
  onSelect?: React.ReactEventHandler<HTMLTextAreaElement>;
  onKeyUp?: React.KeyboardEventHandler<HTMLTextAreaElement>;
  onMouseUp?: React.MouseEventHandler<HTMLTextAreaElement>;
  showLineEndings?: boolean;
  wrap?: boolean;
}) {
  const highlight = useMemo(() => withLineEndings(messageHtml(text, headers, responsePath), showLineEndings, true), [text, headers, responsePath, showLineEndings]);
  const overlay = useRef<HTMLPreElement>(null);
  return <div className={`highlight-editor code-wrap-${wrap ? 'on' : 'off'}${containerClassName ? ` ${containerClassName}` : ''}`}>
    <pre ref={overlay} className="highlight-editor-overlay mono syntax-code" aria-hidden="true"><code dangerouslySetInnerHTML={{ __html: highlight }} /></pre>
    <UndoableTextarea
      textareaRef={editorRef}
      className={className}
      value={text}
      historyKey={historyKey}
      aria-label={label}
      readOnly={readOnly}
      wrap={wrap ? 'soft' : 'off'}
      spellCheck={false}
      onValueChange={onChange}
      onContextMenu={onContextMenu}
      onSelect={onSelect}
      onKeyUp={onKeyUp}
      onMouseUp={onMouseUp}
      onScroll={(event) => {
        if (overlay.current) {
          overlay.current.scrollTop = event.currentTarget.scrollTop;
          overlay.current.scrollLeft = event.currentTarget.scrollLeft;
        }
      }}
    />
  </div>;
}

export function HighlightedBody({
  text,
  headers,
  fallbackMime,
  responsePath,
  className,
  query = '',
  activeIndex = null,
  offset = 0,
  showLineEndings = false,
  wrap = true,
  onMatchCount,
}: {
  text: string;
  headers: SyntaxHeaders;
  fallbackMime?: string | null;
  responsePath?: string | null;
  className?: string;
  query?: string;
  activeIndex?: number | null;
  offset?: number;
  showLineEndings?: boolean;
  wrap?: boolean;
  onMatchCount?: (count: number) => void;
}) {
  if (text.length >= LARGE_TEXT_THRESHOLD) return <Suspense fallback={<LoadingPane />}>
    <LargeTextView text={text} className={`body mono syntax-code${className ? ` ${className}` : ''}`}
      query={query} activeIndex={activeIndex} offset={offset} showLineEndings={showLineEndings} wrap={wrap} onMatchCount={onMatchCount} />
  </Suspense>;
  const language = bodyLanguage(headers, text, fallbackMime, responsePath);
  return <pre {...selectableTextProps} className={`body mono syntax-code code-wrap-${wrap ? 'on' : 'off'}${className ? ` ${className}` : ''}`}><code>
    <SyntaxFragment text={text} language={language} query={query} activeIndex={activeIndex} offset={offset} showLineEndings={showLineEndings} />
  </code></pre>;
}

export function HighlightedMessage(props: {
  text: string;
  headers: SyntaxHeaders;
  fallbackMime?: string | null;
  responsePath?: string | null;
  className: string;
  http?: boolean;
  query?: string;
  activeIndex?: number | null;
  showLineEndings?: boolean;
  wrap?: boolean;
}) {
  if (props.text.length >= LARGE_TEXT_THRESHOLD) return <Suspense fallback={<LoadingPane />}>
    <LargeTextView {...props} className={`${props.className} syntax-code`} />
  </Suspense>;
  return <SmallHighlightedMessage {...props} />;
}

function SmallHighlightedMessage({
  text,
  headers,
  fallbackMime,
  responsePath,
  className,
  http = true,
  query = '',
  activeIndex = null,
  showLineEndings = false,
  wrap = true,
}: {
  text: string;
  headers: SyntaxHeaders;
  fallbackMime?: string | null;
  responsePath?: string | null;
  className: string;
  http?: boolean;
  query?: string;
  activeIndex?: number | null;
  showLineEndings?: boolean;
  wrap?: boolean;
}) {
  const { separator } = useMemo(() => splitMessage(text), [text]);
  const html = useMemo(() => {
    const source = http && separator
      ? messageHtml(text, headers, responsePath, fallbackMime)
      : escapeHtml(text);
    return withLineEndings(markHighlightedHtml(source, query, activeIndex), showLineEndings);
  }, [text, separator, http, headers, responsePath, fallbackMime, query, activeIndex, showLineEndings]);
  return <pre {...selectableTextProps} className={`${className} syntax-code code-wrap-${wrap ? 'on' : 'off'}`}><code dangerouslySetInnerHTML={{ __html: html }} /></pre>;
}

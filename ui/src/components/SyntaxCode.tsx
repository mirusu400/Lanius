import { useMemo, useRef } from 'react';

import hljs from 'highlight.js/lib/core';
import css from 'highlight.js/lib/languages/css';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';

import { splitMessage } from './bodyFormat';
import { bodyLanguage, HIGHLIGHT_LIMIT, type SyntaxHeaders, type SyntaxLanguage } from './syntaxLanguage';
import { markHighlightedHtml } from './searchHighlight';
import { UndoableTextarea } from './UndoableText';

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

function SyntaxFragment({ text, language, query = '', activeIndex = null, offset = 0 }: {
  text: string;
  language: SyntaxLanguage | null;
  query?: string;
  activeIndex?: number | null;
  offset?: number;
}) {
  const html = useMemo(() => {
    return markHighlightedHtml(highlightedHtml(text, language), query, activeIndex, offset);
  }, [text, language, query, activeIndex, offset]);

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
export function HighlightedEditor({ text, onChange, headers, responsePath, className, containerClassName, readOnly = false, label, historyKey, editorRef, onContextMenu, onSelect, onKeyUp, onMouseUp }: {
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
}) {
  const highlight = useMemo(() => messageHtml(text, headers, responsePath), [text, headers, responsePath]);
  const overlay = useRef<HTMLPreElement>(null);
  return <div className={`highlight-editor${containerClassName ? ` ${containerClassName}` : ''}`}>
    <pre ref={overlay} className="highlight-editor-overlay mono syntax-code" aria-hidden="true"><code dangerouslySetInnerHTML={{ __html: highlight }} /></pre>
    <UndoableTextarea
      textareaRef={editorRef}
      className={className}
      value={text}
      historyKey={historyKey}
      aria-label={label}
      readOnly={readOnly}
      wrap="soft"
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
}: {
  text: string;
  headers: SyntaxHeaders;
  fallbackMime?: string | null;
  responsePath?: string | null;
  className?: string;
  query?: string;
  activeIndex?: number | null;
  offset?: number;
}) {
  const language = bodyLanguage(headers, text, fallbackMime, responsePath);
  return <pre className={`body mono syntax-code${className ? ` ${className}` : ''}`}><code>
    <SyntaxFragment text={text} language={language} query={query} activeIndex={activeIndex} offset={offset} />
  </code></pre>;
}

export function HighlightedMessage({
  text,
  headers,
  fallbackMime,
  responsePath,
  className,
  http = true,
  query = '',
  activeIndex = null,
}: {
  text: string;
  headers: SyntaxHeaders;
  fallbackMime?: string | null;
  responsePath?: string | null;
  className: string;
  http?: boolean;
  query?: string;
  activeIndex?: number | null;
}) {
  const { separator } = useMemo(() => splitMessage(text), [text]);
  const html = useMemo(() => {
    const source = http && separator
      ? messageHtml(text, headers, responsePath, fallbackMime)
      : escapeHtml(text);
    return markHighlightedHtml(source, query, activeIndex);
  }, [text, separator, http, headers, responsePath, fallbackMime, query, activeIndex]);
  const selectAll = (event: React.KeyboardEvent<HTMLPreElement>) => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'a') return;
    const selection = window.getSelection();
    if (!selection) return;
    event.preventDefault();
    const range = document.createRange();
    range.selectNodeContents(event.currentTarget);
    selection.removeAllRanges();
    selection.addRange(range);
  };

  return <pre className={`${className} syntax-code`} tabIndex={0} onKeyDown={selectAll}><code dangerouslySetInnerHTML={{ __html: html }} /></pre>;
}

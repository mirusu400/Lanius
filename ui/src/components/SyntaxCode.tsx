import { useMemo } from 'react';

import hljs from 'highlight.js/lib/core';
import css from 'highlight.js/lib/languages/css';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';

import { splitMessage } from './bodyFormat';
import { bodyLanguage, HIGHLIGHT_LIMIT, type SyntaxHeaders, type SyntaxLanguage } from './syntaxLanguage';
import { markHighlightedHtml } from './searchHighlight';

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
      if (request) return `<span class="hljs-keyword">${escapeHtml(request[1])}</span>${escapeHtml(request[2])}<span class="hljs-link">${escapeHtml(request[3])}</span>${escapeHtml(request[4])}<span class="hljs-meta">${escapeHtml(request[5])}</span>`;
      const response = line.match(/^(HTTP\/\S+)(\s+)(\d{3})(.*)$/);
      if (response) return `<span class="hljs-meta">${escapeHtml(response[1])}</span>${escapeHtml(response[2])}<span class="hljs-number">${escapeHtml(response[3])}</span>${escapeHtml(response[4])}`;
    }

    const header = line.match(/^([^:\r\n]+)(:)(.*)$/);
    return header
      ? `<span class="hljs-attr">${escapeHtml(header[1])}</span>${escapeHtml(header[2])}${escapeHtml(header[3])}`
      : escapeHtml(line);
  }).join('');
}

export function HighlightedBody({
  text,
  headers,
  fallbackMime,
  responsePath,
  query = '',
  activeIndex = null,
  offset = 0,
}: {
  text: string;
  headers: SyntaxHeaders;
  fallbackMime?: string | null;
  responsePath?: string | null;
  query?: string;
  activeIndex?: number | null;
  offset?: number;
}) {
  const language = bodyLanguage(headers, text, fallbackMime, responsePath);
  return <pre className="body mono syntax-code"><code>
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
  const { head, separator, body } = useMemo(() => splitMessage(text), [text]);
  const language = bodyLanguage(headers, body, fallbackMime, responsePath);
  const html = useMemo(() => {
    const source = http && separator
      ? messageHeadHtml(head) + escapeHtml(separator) + highlightedHtml(body, language)
      : escapeHtml(text);
    return markHighlightedHtml(source, query, activeIndex);
  }, [text, head, separator, body, http, language, query, activeIndex]);
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

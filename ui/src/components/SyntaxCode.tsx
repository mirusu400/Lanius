import { useMemo } from 'react';

import hljs from 'highlight.js/lib/core';
import css from 'highlight.js/lib/languages/css';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';

import { splitMessage } from './bodyFormat';
import { bodyLanguage, HIGHLIGHT_LIMIT, type SyntaxHeaders, type SyntaxLanguage } from './syntaxLanguage';

// Register only the grammars used by captured HTTP bodies. XML also handles
// HTML and its embedded script/style elements.
hljs.registerLanguage('css', css);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('xml', xml);

function SyntaxFragment({ text, language }: { text: string; language: SyntaxLanguage | null }) {
  const html = useMemo(() => {
    if (!language || !text || text.length > HIGHLIGHT_LIMIT) return null;
    // highlight() escapes source markup before adding its own token spans.
    return hljs.highlight(text, { language, ignoreIllegals: true }).value;
  }, [text, language]);

  return html === null ? text : <span dangerouslySetInnerHTML={{ __html: html }} />;
}

function MessageHead({ text }: { text: string }) {
  return text.split(/(\r?\n)/).map((line, index) => {
    if (index % 2) return line;

    if (index === 0) {
      const request = line.match(/^([A-Z]+)(\s+)(\S+)(\s+)(HTTP\/\S+)$/);
      if (request) return <span key={index}>
        <span className="hljs-keyword">{request[1]}</span>{request[2]}
        <span className="hljs-link">{request[3]}</span>{request[4]}
        <span className="hljs-meta">{request[5]}</span>
      </span>;
      const response = line.match(/^(HTTP\/\S+)(\s+)(\d{3})(.*)$/);
      if (response) return <span key={index}>
        <span className="hljs-meta">{response[1]}</span>{response[2]}
        <span className="hljs-number">{response[3]}</span>{response[4]}
      </span>;
    }

    const header = line.match(/^([^:\r\n]+)(:)(.*)$/);
    return header
      ? <span key={index}><span className="hljs-attr">{header[1]}</span>{header[2]}{header[3]}</span>
      : line;
  });
}

export function HighlightedBody({
  text,
  headers,
  fallbackMime,
  responsePath,
}: {
  text: string;
  headers: SyntaxHeaders;
  fallbackMime?: string | null;
  responsePath?: string | null;
}) {
  const language = bodyLanguage(headers, text, fallbackMime, responsePath);
  return <pre className="body mono syntax-code"><code>
    <SyntaxFragment text={text} language={language} />
  </code></pre>;
}

export function HighlightedMessage({
  text,
  headers,
  fallbackMime,
  responsePath,
  className,
  http = true,
}: {
  text: string;
  headers: SyntaxHeaders;
  fallbackMime?: string | null;
  responsePath?: string | null;
  className: string;
  http?: boolean;
}) {
  const { head, separator, body } = useMemo(() => splitMessage(text), [text]);
  const language = bodyLanguage(headers, body, fallbackMime, responsePath);
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

  return <pre className={`${className} syntax-code`} tabIndex={0} onKeyDown={selectAll}><code>
    {http && separator ? <><MessageHead text={head} />{separator}
      <SyntaxFragment text={body} language={language} /></> : text}
  </code></pre>;
}

import { defaultTreeAdapter, html, parseFragment, serialize, type DefaultTreeAdapterTypes } from 'parse5';

import { findMatches } from './searchHighlight';

const HIDDEN_TEXT = new Set(['script', 'style', 'noscript', 'template', 'title', 'textarea', 'head', 'svg']);

interface MatchSnippet {
  before: string;
  match: string;
  after: string;
}

/** Search captured HTML as data, before it enters its script-free sandbox. */
export function markHtmlPreview(source: string, query: string, activeIndex: number | null): { html: string; count: number; snippets: MatchSnippet[] } {
  if (!query) return { html: source, count: 0, snippets: [] };
  const fragment = parseFragment(source);
  const textNodes: DefaultTreeAdapterTypes.TextNode[] = [];
  const visit = (node: DefaultTreeAdapterTypes.Node) => {
    if (node.nodeName === '#text') {
      textNodes.push(node as DefaultTreeAdapterTypes.TextNode);
      return;
    }
    if ('tagName' in node && HIDDEN_TEXT.has(node.tagName)) return;
    if ('childNodes' in node) node.childNodes.forEach(visit);
  };
  visit(fragment);

  const visibleText = textNodes.map((node) => node.value).join('');
  const matches = findMatches(visibleText, query);
  if (!matches.length) return { html: source, count: 0, snippets: [] };
  const snippets = matches.map(({ start, end }) => ({
    before: visibleText.slice(Math.max(0, start - 40), start).replace(/\s+/g, ' '),
    match: visibleText.slice(start, end),
    after: visibleText.slice(end, Math.min(visibleText.length, end + 40)).replace(/\s+/g, ' '),
  }));
  let position = 0;
  let first = 0;
  for (const node of textNodes) {
    const value = node.value;
    const end = position + value.length;
    while (first < matches.length && matches[first].end <= position) first += 1;
    let cursor = 0;
    const parent = node.parentNode;
    if (!parent) continue;
    for (let i = first; i < matches.length && matches[i].start < end; i += 1) {
      const start = Math.max(0, matches[i].start - position);
      const finish = Math.min(value.length, matches[i].end - position);
      if (start > cursor) defaultTreeAdapter.insertBefore(parent, defaultTreeAdapter.createTextNode(value.slice(cursor, start)), node);
      const attrs = [{ name: 'data-find-index', value: String(i) }];
      if (i === activeIndex) {
        attrs.push({ name: 'class', value: 'find-current' });
      }
      const mark = defaultTreeAdapter.createElement('mark', html.NS.HTML, attrs);
      defaultTreeAdapter.appendChild(mark, defaultTreeAdapter.createTextNode(value.slice(start, finish)));
      defaultTreeAdapter.insertBefore(parent, mark, node);
      cursor = finish;
    }
    if (cursor) {
      if (cursor < value.length) defaultTreeAdapter.insertBefore(parent, defaultTreeAdapter.createTextNode(value.slice(cursor)), node);
      defaultTreeAdapter.detachNode(node);
    }
    position = end;
  }
  return { html: serialize(fragment), count: matches.length, snippets };
}

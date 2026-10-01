export interface MatchRange {
  start: number;
  end: number;
}

/** Literal, case-insensitive search with offsets in the original text. */
export function findMatches(text: string, query: string): MatchRange[] {
  if (!query) return [];
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expression = new RegExp(escaped, 'gi');
  const matches: MatchRange[] = [];
  for (const match of text.matchAll(expression)) {
    matches.push({ start: match.index, end: match.index + match[0].length });
  }
  return matches;
}

export function matchCount(text: string, query: string): number {
  return findMatches(text, query).length;
}

/** Add marks to trusted syntax-highlighter markup, including matches crossing token spans. */
export function markHighlightedHtml(html: string, query: string, activeIndex: number | null, offset = 0): string {
  if (!query) return html.replace(/\r/g, '&#13;');
  const template = document.createElement('template');
  // HTML parsing normalises literal CRLF. Entities preserve captured raw bytes.
  template.innerHTML = html.replace(/\r/g, '&#13;');
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) nodes.push(node as Text);
  const matches = findMatches(template.content.textContent || '', query);
  if (!matches.length) return html.replace(/\r/g, '&#13;');
  let position = 0;
  let index = 0;
  for (const textNode of nodes) {
    const value = textNode.data;
    const end = position + value.length;
    while (index < matches.length && matches[index].end <= position) index += 1;
    let cursor = 0;
    const replacement = document.createDocumentFragment();
    for (let i = index; i < matches.length && matches[i].start < end; i += 1) {
      const match = matches[i];
      const startInNode = Math.max(0, match.start - position);
      const endInNode = Math.min(value.length, match.end - position);
      if (startInNode > cursor) replacement.append(value.slice(cursor, startInNode));
      const mark = document.createElement('mark');
      mark.dataset.findIndex = String(offset + i);
      if (offset + i === activeIndex) mark.className = 'find-current';
      mark.textContent = value.slice(startInNode, endInNode);
      replacement.append(mark);
      cursor = endInNode;
    }
    if (cursor) {
      replacement.append(value.slice(cursor));
      textNode.replaceWith(replacement);
    }
    position = end;
  }
  return template.innerHTML.replace(/\r/g, '&#13;');
}

import type { ReactNode } from 'react';

import { findMatches } from './searchHighlight';

export function MarkedText({ text, query, offset = 0, activeIndex = null }: {
  text: string;
  query: string;
  offset?: number;
  activeIndex?: number | null;
}) {
  const matches = findMatches(text, query);
  if (!matches.length) return text;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const [index, match] of matches.entries()) {
    parts.push(text.slice(cursor, match.start));
    parts.push(<mark key={match.start} className={offset + index === activeIndex ? 'find-current' : undefined} data-find-index={offset + index}>{text.slice(match.start, match.end)}</mark>);
    cursor = match.end;
  }
  parts.push(text.slice(cursor));
  return <>{parts}</>;
}

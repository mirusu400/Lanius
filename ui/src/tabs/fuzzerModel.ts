/** Pure helpers for the Fuzzer tab. */

import type { RunResult, RunMode, FlowDetail, FlowSummary } from '../api/types';
import type { TranslationKey } from '../i18n/catalogue';

export const OPEN_MARKER = '{{';
export const CLOSE_MARKER = '}}';

export const RUN_MODES: {
  value: RunMode;
  label: string;
  hint: TranslationKey;
}[] = [
  {
    value: 'single_position',
    label: 'Single position',
    hint: 'fuzzer.singlePositionHint',
  },
  {
    value: 'shared_payload',
    label: 'Shared payload',
    hint: 'fuzzer.sharedPayloadHint',
  },
  { value: 'lockstep', label: 'Lockstep', hint: 'fuzzer.lockstepHint' },
  {
    value: 'cartesian',
    label: 'Cartesian product',
    hint: 'fuzzer.cartesianHint',
  },
];

interface MarkerSpan {
  start: number;
  end: number;
  value: string;
}

/**
 * Locate `{{...}}` spans; null means markers are invalid. A marker ends at
 * the first close after it, and a close outside any marker is ordinary
 * text, since nested JSON and GraphQL end in `}}` all the time.
 */
function findMarkers(template: string): MarkerSpan[] | null {
  const spans: MarkerSpan[] = [];
  let cursor = 0;
  for (;;) {
    const open = template.indexOf(OPEN_MARKER, cursor);
    if (open < 0) return spans;
    const valueStart = open + OPEN_MARKER.length;
    const end = template.indexOf(CLOSE_MARKER, valueStart);
    if (end < 0) return null;
    const nested = template.indexOf(OPEN_MARKER, valueStart);
    if (nested >= 0 && nested < end) return null;
    spans.push({ start: open, end: end + CLOSE_MARKER.length, value: template.slice(valueStart, end) });
    cursor = end + CLOSE_MARKER.length;
  }
}

/** Count payload positions; -1 means markers are invalid. */
export function countPositions(template: string): number {
  return findMarkers(template)?.length ?? -1;
}

/** Wrap the current selection in payload markers. */
export function addMarker(
  template: string,
  start: number,
  end: number,
): string {
  if (start === end) return template;
  return (
    template.slice(0, start) +
    OPEN_MARKER +
    template.slice(start, end) +
    CLOSE_MARKER +
    template.slice(end)
  );
}

/** The template with markers removed and their base values kept. */
export function clearMarkers(template: string): string {
  const spans = findMarkers(template);
  if (!spans) {
    // Unbalanced: drop only the opening markers, so a stray close in the
    // body (nested JSON) survives.
    return template.split(OPEN_MARKER).join('');
  }
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += template.slice(cursor, span.start) + span.value;
    cursor = span.end;
  }
  return out + template.slice(cursor);
}

/** Parse a textarea wordlist into payloads (blank lines dropped). */
export function parsePayloads(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Expected request count, mirroring the engine (shown before launching). */
export function estimateRequests(
  mode: RunMode,
  positions: number,
  sets: string[][],
): number {
  return estimateRequestsFromCounts(mode, positions, sets.map((set) => set.length));
}

/** Also used by Payload Maker before a potentially large list exists. */
export function estimateRequestsFromCounts(mode: RunMode, positions: number, counts: readonly number[]): number {
  if (positions <= 0 || counts.length === 0) return 0;
  switch (mode) {
    case 'single_position':
      return positions * (counts[0] ?? 0);
    case 'shared_payload':
      return counts[0] ?? 0;
    case 'lockstep': {
      const used = counts.slice(0, positions);
      if (used.length < positions) return 0;
      return Math.min(...used);
    }
    case 'cartesian': {
      const used = counts.slice(0, positions);
      if (used.length < positions) return 0;
      return used.reduce((total, count) => total * count, 1);
    }
  }
}

/** How many payload sets a given run type consumes. */
export function requiredSets(
  mode: RunMode,
  positions: number,
): number {
  return mode === 'single_position' || mode === 'shared_payload'
    ? 1
    : Math.max(positions, 1);
}

/** Build the initial template from a captured flow. */
export function templateFromFlow(
  flow: FlowSummary,
  detail?: FlowDetail | null,
): { url: string; template: string } {
  const isDefaultPort =
    (flow.scheme === 'https' && flow.port === 443) ||
    (flow.scheme === 'http' && flow.port === 80);
  const url = `${flow.scheme}://${flow.host}${
    isDefaultPort ? '' : `:${flow.port}`
  }`;
  const target = `${flow.path ?? '/'}${flow.query ? `?${flow.query}` : ''}`;
  const headers = detail?.request_headers ?? [['Host', flow.host ?? '']];
  const headerText = headers.map(([k, v]) => `${k}: ${v}`).join('\n');
  const body = detail?.request_body ?? '';
  return {
    url,
    template: `${flow.method} ${target} ${flow.http_version ?? 'HTTP/1.1'}\n${headerText}\n\n${body}`,
  };
}

/** Results whose length differs from the majority often indicate a hit. */
export function markOutliers(results: RunResult[]): Set<number> {
  if (results.length < 3) return new Set();
  const counts = new Map<number, number>();
  for (const result of results) {
    counts.set(result.length, (counts.get(result.length) ?? 0) + 1);
  }
  let common = -1;
  let best = -1;
  for (const [length, count] of counts) {
    if (count > best) {
      best = count;
      common = length;
    }
  }
  // Only meaningful when one length really dominates.
  if (best < results.length / 2) return new Set();
  return new Set(
    results.filter((r) => r.length !== common).map((r) => r.index),
  );
}

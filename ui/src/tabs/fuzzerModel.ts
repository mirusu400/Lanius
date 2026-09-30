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

/** Count balanced `{{...}}` spans; -1 means markers are invalid. */
export function countPositions(template: string): number {
  let cursor = 0;
  let count = 0;
  while (cursor < template.length) {
    const open = template.indexOf(OPEN_MARKER, cursor);
    const close = template.indexOf(CLOSE_MARKER, cursor);
    if (open < 0) return close < 0 ? count : -1;
    if (close >= 0 && close < open) return -1;
    const end = template.indexOf(CLOSE_MARKER, open + OPEN_MARKER.length);
    if (end < 0) return -1;
    const nested = template.indexOf(OPEN_MARKER, open + OPEN_MARKER.length);
    if (nested >= 0 && nested < end) return -1;
    count += 1;
    cursor = end + CLOSE_MARKER.length;
  }
  return count;
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

export function clearMarkers(template: string): string {
  return template
    .split(OPEN_MARKER).join('')
    .split(CLOSE_MARKER).join('');
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
  if (positions <= 0 || sets.length === 0) return 0;
  switch (mode) {
    case 'single_position':
      return positions * (sets[0]?.length ?? 0);
    case 'shared_payload':
      return sets[0]?.length ?? 0;
    case 'lockstep': {
      const used = sets.slice(0, positions);
      if (used.length < positions) return 0;
      return Math.min(...used.map((s) => s.length));
    }
    case 'cartesian': {
      const used = sets.slice(0, positions);
      if (used.length < positions) return 0;
      return used.reduce((total, s) => total * s.length, 1);
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

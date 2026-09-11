/** Pure helpers for the Intruder tab. */

import type { AttackResult, AttackType, FlowDetail, FlowSummary } from '../api/types';
import type { TranslationKey } from '../i18n/catalogue';

export const MARKER = '\u00a7';

export const ATTACK_TYPES: {
  value: AttackType;
  label: string;
  hint: TranslationKey;
}[] = [
  { value: 'sniper', label: 'Sniper', hint: 'intruder.sniperHint' },
  {
    value: 'battering_ram',
    label: 'Battering ram',
    hint: 'intruder.batteringRamHint',
  },
  { value: 'pitchfork', label: 'Pitchfork', hint: 'intruder.pitchforkHint' },
  {
    value: 'cluster_bomb',
    label: 'Cluster bomb',
    hint: 'intruder.clusterBombHint',
  },
];

/** Count balanced `§...§` spans; -1 means the markers are unbalanced. */
export function countPositions(template: string): number {
  const occurrences = (template.match(new RegExp(MARKER, 'g')) ?? []).length;
  if (occurrences % 2 !== 0) return -1;
  return occurrences / 2;
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
    MARKER +
    template.slice(start, end) +
    MARKER +
    template.slice(end)
  );
}

export function clearMarkers(template: string): string {
  return template.split(MARKER).join('');
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
  attackType: AttackType,
  positions: number,
  sets: string[][],
): number {
  if (positions <= 0 || sets.length === 0) return 0;
  switch (attackType) {
    case 'sniper':
      return positions * (sets[0]?.length ?? 0);
    case 'battering_ram':
      return sets[0]?.length ?? 0;
    case 'pitchfork': {
      const used = sets.slice(0, positions);
      if (used.length < positions) return 0;
      return Math.min(...used.map((s) => s.length));
    }
    case 'cluster_bomb': {
      const used = sets.slice(0, positions);
      if (used.length < positions) return 0;
      return used.reduce((total, s) => total * s.length, 1);
    }
  }
}

/** How many payload sets a given attack type consumes. */
export function requiredSets(
  attackType: AttackType,
  positions: number,
): number {
  return attackType === 'sniper' || attackType === 'battering_ram'
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
export function markOutliers(results: AttackResult[]): Set<number> {
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

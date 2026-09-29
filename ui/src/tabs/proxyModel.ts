/** Pure helpers for the proxy history table (unit tested). */

import type { FlowFilters, FlowSummary } from '../api/types';

export const MAX_FLOWS = 5000;

/** Insert or replace a flow, keeping newest-first order and bounding memory. */
export function mergeFlow(
  flows: FlowSummary[],
  incoming: FlowSummary,
  maxFlows = MAX_FLOWS,
): FlowSummary[] {
  const index = flows.findIndex((f) => f.id === incoming.id);
  if (index >= 0) {
    const next = flows.slice();
    next[index] = { ...next[index], ...incoming };
    return next;
  }
  return [incoming, ...flows].slice(0, maxFlows);
}

export function matchesFilters(
  flow: FlowSummary,
  filters: FlowFilters,
): boolean {
  if (filters.host && !(flow.host ?? '').toLowerCase().includes(filters.host.toLowerCase())) return false;
  if (filters.method && flow.method !== filters.method.toUpperCase()) {
    return false;
  }
  if (
    filters.statusCode !== undefined &&
    !Number.isNaN(filters.statusCode) &&
    flow.status_code !== filters.statusCode
  ) {
    return false;
  }
  if (filters.methods?.length && !filters.methods.some((method) => method.toUpperCase() === flow.method)) return false;
  if (filters.statusClasses?.length && !filters.statusClasses.includes(Math.floor((flow.status_code ?? 0) / 100))) return false;
  const filename = (flow.path ?? '').split('/').pop() ?? '';
  const extension = filename.includes('.') ? filename.split('.').pop()?.toLowerCase() : undefined;
  if (filters.extensions?.length && !filters.extensions.some((ext) => ext.toLowerCase().replace(/^\./, '') === extension)) return false;
  if (filters.excludeExtensions?.some((ext) => ext.toLowerCase().replace(/^\./, '') === extension)) return false;
  if (filters.search) {
    const needle = filters.search.toLowerCase();
    const haystack =
      `${flow.host ?? ''}${flow.path ?? ''}${flow.query ?? ''}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

export function statusClass(status: number | null): string {
  if (status === null) return 'status-pending';
  if (status < 200) return 'status-1xx';
  if (status < 300) return 'status-2xx';
  if (status < 400) return 'status-3xx';
  if (status < 500) return 'status-4xx';
  return 'status-5xx';
}

export function formatUrl(flow: FlowSummary): string {
  const port =
    (flow.scheme === 'https' && flow.port === 443) ||
    (flow.scheme === 'http' && flow.port === 80)
      ? ''
      : `:${flow.port ?? ''}`;
  const query = flow.query ? `?${flow.query}` : '';
  return `${flow.scheme}://${flow.host}${port}${flow.path ?? ''}${query}`;
}

export function formatTime(ts: number | null): string {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleTimeString('en-GB', { hour12: false });
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/** REST client for the Lanius engine. */

import type { EngineStatus, FlowDetail, FlowFilters, FlowSummary } from './types';

export const API_BASE =
  import.meta.env.VITE_LANIUS_API ?? 'http://127.0.0.1:8081';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export function buildFlowQuery(filters: FlowFilters, limit = 200): string {
  const params = new URLSearchParams({ limit: String(limit) });
  if (filters.host) params.set('host', filters.host);
  if (filters.method) params.set('method', filters.method);
  if (filters.statusCode !== undefined && !Number.isNaN(filters.statusCode)) {
    params.set('status_code', String(filters.statusCode));
  }
  if (filters.search) params.set('search', filters.search);
  return params.toString();
}

export function getStatus(): Promise<EngineStatus> {
  return request<EngineStatus>('/api/status');
}

export async function listFlows(
  filters: FlowFilters = {},
  limit = 200,
): Promise<FlowSummary[]> {
  const data = await request<{ items: FlowSummary[]; count: number }>(
    `/api/flows?${buildFlowQuery(filters, limit)}`,
  );
  return data.items;
}

export function getFlow(id: string, reveal = false): Promise<FlowDetail> {
  return request<FlowDetail>(`/api/flows/${id}${reveal ? '?reveal=true' : ''}`);
}

export function clearFlows(): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/api/flows', { method: 'DELETE' });
}

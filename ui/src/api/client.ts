/** REST client for the Lanius engine. */

import type {
  EngineStatus,
  FlowDetail,
  FlowEdits,
  FlowFilters,
  FlowSummary,
  InterceptRules,
  PausedFlow,
} from './types';

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

// --- intercept (M2) -------------------------------------------------------

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function getInterceptState(): Promise<{
  rules: InterceptRules;
  paused: PausedFlow[];
}> {
  return request('/api/intercept');
}

export function patchInterceptRules(
  patch: Partial<InterceptRules>,
): Promise<InterceptRules> {
  return request<InterceptRules>('/api/intercept', {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  });
}

export function forwardFlow(
  id: string,
  edits: FlowEdits = {},
): Promise<{ ok: boolean }> {
  return request(`/api/intercept/${id}/forward`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(edits),
  });
}

export function dropFlow(id: string): Promise<{ ok: boolean }> {
  return request(`/api/intercept/${id}/drop`, { method: 'POST' });
}

export function forwardAll(): Promise<{ forwarded: number }> {
  return request('/api/intercept/forward-all', { method: 'POST' });
}

// --- repeater (M3) --------------------------------------------------------

export function sendRepeaterRequest(payload: {
  url: string;
  method: string;
  headers: [string, string][];
  body: string;
}): Promise<import('../tabs/repeaterModel').RepeaterResponse> {
  return request('/api/repeater/send', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });
}

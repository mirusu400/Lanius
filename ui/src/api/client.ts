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

// --- target / scope (M4) --------------------------------------------------

export function getScope(): Promise<import('./types').ScopeState> {
  return request('/api/scope');
}

export function addScopeRule(
  rule: Partial<import('./types').ScopeRule>,
): Promise<import('./types').ScopeRule> {
  return request('/api/scope/rules', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(rule),
  });
}

export function addScopeFromUrl(
  url: string,
  kind: 'include' | 'exclude' = 'include',
): Promise<import('./types').ScopeRule> {
  return request('/api/scope/from-url', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ url, kind }),
  });
}

export function patchScopeRule(
  id: number,
  patch: Partial<import('./types').ScopeRule>,
): Promise<import('./types').ScopeState> {
  return request(`/api/scope/rules/${id}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  });
}

export function deleteScopeRule(id: number): Promise<{ ok: boolean }> {
  return request(`/api/scope/rules/${id}`, { method: 'DELETE' });
}

export function setRestrictCapture(
  restrict_capture: boolean,
): Promise<import('./types').ScopeState> {
  return request('/api/scope', {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ restrict_capture }),
  });
}

export function getSitemap(
  inScopeOnly = false,
): Promise<{ sites: import('./types').Site[] }> {
  return request(`/api/sitemap?in_scope_only=${inScopeOnly}`);
}

export function getSitePaths(
  host: string,
  scheme: string,
  port: number | null,
): Promise<{ items: import('./types').SitePath[]; count: number }> {
  const params = new URLSearchParams({ host, scheme });
  if (port !== null) params.set('port', String(port));
  return request(`/api/sitemap/paths?${params}`);
}

export function getEndpoints(
  host?: string,
  inScopeOnly = false,
): Promise<{ items: import('./types').EndpointGroup[]; count: number }> {
  const params = new URLSearchParams({ in_scope_only: String(inScopeOnly) });
  if (host) params.set('host', host);
  return request(`/api/endpoints?${params}`);
}

// --- intruder (M5) --------------------------------------------------------

export function getPositions(
  template: string,
): Promise<{ count: number; preview: string }> {
  return request('/api/intruder/positions', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ template }),
  });
}

export interface AttackConfig {
  url: string;
  template: string;
  attack_type: import('./types').AttackType;
  payload_sets: string[][];
}

export function planAttack(config: AttackConfig): Promise<{ total: number }> {
  return request('/api/intruder/plan', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(config),
  });
}

export function startAttack(
  config: AttackConfig,
): Promise<import('./types').AttackSummary> {
  return request('/api/intruder/attacks', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(config),
  });
}

export function getAttack(id: string): Promise<import('./types').Attack> {
  return request(`/api/intruder/attacks/${id}`);
}

export function stopAttack(
  id: string,
): Promise<import('./types').AttackSummary> {
  return request(`/api/intruder/attacks/${id}/stop`, { method: 'POST' });
}

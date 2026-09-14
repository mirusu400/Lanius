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

/** Engine base URL.
 *
 * In the Tauri shell the engine runs as a sidecar on the default port; in the
 * browser dev setup VITE_LANIUS_API can point elsewhere.
 */
export const API_BASE =
  (typeof window !== 'undefined' &&
    (window as { __LANIUS_API__?: string }).__LANIUS_API__) ||
  import.meta.env.VITE_LANIUS_API ||
  'http://127.0.0.1:8081';

/** True when running inside the desktop shell. */
export function isDesktop(): boolean {
  return (
    typeof window !== 'undefined' &&
    '__TAURI_INTERNALS__' in (window as unknown as Record<string, unknown>)
  );
}

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
  // An unexpected shape (an older engine, or a proxy returning something
  // else) must not hand back undefined: callers treat this as a list and
  // would crash on the first .find().
  return data?.items ?? [];
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

// --- decoder / comparer (M6) ----------------------------------------------

export interface ChainStep {
  codec: string;
  direction: 'encode' | 'decode';
}

export function listCodecs(): Promise<{ codecs: string[]; hashes: string[] }> {
  return request('/api/codecs');
}

export function decodeChain(
  value: string,
  steps: ChainStep[],
): Promise<{
  input: string;
  output: string;
  steps: { codec: string; direction: string; value: string }[];
}> {
  return request('/api/decode', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ value, steps }),
  });
}

export interface CompareBlock {
  tag: 'equal' | 'insert' | 'delete' | 'replace';
  left: string;
  right: string;
}

export function compareTexts(
  left: string,
  right: string,
  mode: 'word' | 'byte' = 'word',
): Promise<{
  mode: string;
  blocks: CompareBlock[];
  added: number;
  removed: number;
  unchanged: number;
  similarity: number;
  identical: boolean;
}> {
  return request('/api/compare', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ left, right, mode }),
  });
}

// --- plugins (M7) ---------------------------------------------------------

export function listPlugins(): Promise<{
  items: import('./types').PluginInfo[];
  directory: string;
}> {
  return request('/api/plugins');
}

export function setPluginEnabled(
  name: string,
  enabled: boolean,
): Promise<import('./types').PluginInfo> {
  return request(`/api/plugins/${name}/${enabled ? 'enable' : 'disable'}`, {
    method: 'POST',
  });
}

export function reloadPlugin(
  name: string,
): Promise<import('./types').PluginInfo> {
  return request(`/api/plugins/${name}/reload`, { method: 'POST' });
}

// --- logger / CA ----------------------------------------------------------

export interface LogEvent {
  id: number;
  ts: number;
  level: string;
  message: string;
}

export function listEvents(limit = 200): Promise<{ items: LogEvent[] }> {
  return request(`/api/events?limit=${limit}`);
}

export interface CaInfo {
  confdir: string;
  available: Record<string, boolean>;
  install_url: string;
  proxy: string;
}

export function getCaInfo(): Promise<CaInfo> {
  return request('/api/ca');
}

export function caDownloadUrl(format: string): string {
  return `${API_BASE}/api/ca/${format}`;
}

export function getDashboard(top = 8): Promise<import('./types').Dashboard> {
  return request(`/api/dashboard?top=${top}`);
}

export function setLocalCapture(
  spec: string | null,
): Promise<import('./types').LocalCaptureState & { spec: string | null }> {
  return request('/api/capture/local', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // null switches capture off; '' turns it on for every process, so the
    // two must stay distinct on the wire.
    body: JSON.stringify({ spec }),
  });
}

export function getListener(): Promise<import('./types').ListenerState> {
  return request('/api/listener');
}

export function setListener(
  host: string,
  port: number,
): Promise<import('./types').ListenerState> {
  return request('/api/listener', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host, port }),
  });
}

export function getTlsState(): Promise<import('./types').TlsState> {
  return request('/api/tls');
}

export function setTlsProfile(
  profile: string,
  ciphers?: string | null,
): Promise<import('./types').TlsState> {
  return request('/api/tls', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile, ciphers: ciphers ?? '' }),
  });
}

export interface ProcessInfo {
  name: string;
  path: string;
  visible: boolean;
  system: boolean;
}

export function listProcesses(visibleOnly = true): Promise<{
  items: ProcessInfo[];
  count: number;
}> {
  return request(`/api/processes?visible_only=${visibleOnly}`);
}

export function getWorkspace<T>(key: string): Promise<{ key: string; value: T | null }> {
  return request(`/api/workspace/${key}`);
}

export function putWorkspace(key: string, value: unknown): Promise<{ ok: boolean }> {
  return request(`/api/workspace/${key}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  });
}

export function exportProject(includeFlows = true): Promise<Record<string, unknown>> {
  return request(`/api/project/export?include_flows=${includeFlows}`);
}

export function importProject(
  document: unknown,
): Promise<{ ok: boolean; flows: number; scope: number; workspace: number }> {
  return request('/api/project/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(document),
  });
}

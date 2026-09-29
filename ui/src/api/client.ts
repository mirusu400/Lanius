/** REST client for the Lanius engine. */

import type {
  BodyDisplaySettings,
  EngineStatus,
  FlowDetail,
  FlowEdits,
  FlowFilters,
  FlowSummary,
  ResponsePreview,
  InterceptRules,
  MatchReplaceRule,
  PausedFlow,
  WebSocketInterceptRules,
  WebSocketMessage,
  WebSocketState,
} from './types';

/** Engine base URL. The desktop shell can change it while the UI is open. */
export let API_BASE =
  (typeof window !== 'undefined' &&
    (window as { __LANIUS_API__?: string }).__LANIUS_API__) ||
  import.meta.env.VITE_LANIUS_API ||
  'http://127.0.0.1:12954';

export function setApiBase(url: string): void {
  API_BASE = url;
}

export async function syncApiBaseWithShell(): Promise<void> {
  if (!isDesktop()) return;
  const internals = (window as unknown as {
    __TAURI_INTERNALS__: { invoke(cmd: string): Promise<{ api_url: string }> };
  }).__TAURI_INTERNALS__;
  const info = await internals.invoke('engine_info');
  setApiBase(info.api_url);
}

export async function setDesktopApiPort(port: number): Promise<void> {
  if (!isDesktop()) throw new Error('Desktop shell is unavailable');
  const internals = (window as unknown as {
    __TAURI_INTERNALS__: { invoke(cmd: string, args: { port: number }): Promise<{ api_url: string }> };
  }).__TAURI_INTERNALS__;
  const info = await internals.invoke('set_api_port', { port });
  setApiBase(info.api_url);
}

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
    // The engine explains refusals in `detail`: which port was busy, that
    // no browser is installed. Reporting only the status threw that away
    // and left the user with "409 Conflict", or worse "409 undefined"
    // where the runtime has no statusText.
    throw new Error(await errorDetail(res));
  }
  return (await res.json()) as T;
}

/** The server's explanation, falling back to whatever the status says. */
async function errorDetail(res: Response): Promise<string> {
  try {
    // clone() where available, since the body can only be read once; some
    // environments hand back a plain object without it.
    const source = typeof res.clone === 'function' ? res.clone() : res;
    const body = (await source.json()) as { detail?: unknown };
    if (typeof body?.detail === 'string' && body.detail) return body.detail;
  } catch {
    // Not JSON, or already consumed: fall through to the status.
  }
  return res.statusText ? `${res.status} ${res.statusText}` : `HTTP ${res.status}`;
}

export function buildFlowQuery(filters: FlowFilters, limit = 200, offset = 0, anchor?: number, cursor?: string): string {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set('cursor', cursor);
  else if (offset) params.set('offset', String(offset));
  if (anchor !== undefined) params.set('anchor', String(anchor));
  if (filters.host) params.set('host', filters.host);
  if (filters.method) params.set('method', filters.method);
  if (filters.statusCode !== undefined && !Number.isNaN(filters.statusCode)) {
    params.set('status_code', String(filters.statusCode));
  }
  if (filters.search) params.set('search', filters.search);
  // Repeated rather than joined: the engine reads these as a list, so
  // ?methods=GET&methods=POST is two values and not one called "GET,POST".
  for (const method of filters.methods ?? []) params.append('methods', method);
  for (const cls of filters.statusClasses ?? []) {
    params.append('status_classes', String(cls));
  }
  for (const ext of filters.extensions ?? []) params.append('extensions', ext);
  for (const ext of filters.excludeExtensions ?? []) {
    params.append('exclude_extensions', ext);
  }
  if (filters.inScopeOnly) params.set('in_scope_only', 'true');
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

export async function listFlowPage(
  filters: FlowFilters = {}, offset = 0, limit = 200, anchor?: number, cursor?: string,
): Promise<{ items: FlowSummary[]; has_more: boolean; anchor?: number; next_cursor?: string | null }> {
  const data = await request<{ items: FlowSummary[]; has_more?: boolean; anchor?: number; next_cursor?: string | null }>(
    `/api/flows?${buildFlowQuery(filters, limit, offset, anchor, cursor)}`,
  );
  return { items: data?.items ?? [], has_more: data?.has_more ?? false,
    anchor: data?.anchor, next_cursor: data?.next_cursor };
}

export function getFlow(id: string, reveal = false): Promise<FlowDetail> {
  return request<FlowDetail>(`/api/flows/${id}${reveal ? '?reveal=true' : ''}`);
}

export function getResponsePreview(id: string): Promise<ResponsePreview> {
  return request<ResponsePreview>(`/api/flows/${encodeURIComponent(id)}/response-preview`);
}

export function clearFlows(): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/api/flows', { method: 'DELETE' });
}

/** Remove part of the history: either a set of rows, or the subtree a
 *  site map folder stands for. The engine vacuums afterwards, so the
 *  database file actually gets smaller. */
export function deleteFlows(target: {
  ids?: string[];
  subtrees?: { host: string; port?: number | null; scheme?: string; pathPrefix?: string }[];
  host?: string;
  port?: number | null;
  scheme?: string;
  pathPrefix?: string;
}): Promise<{ deleted: number }> {
  return request<{ deleted: number }>('/api/flows/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ids: target.ids,
      subtrees: target.subtrees?.map((subtree) => ({
        host: subtree.host,
        port: subtree.port ?? undefined,
        port_is_null: subtree.port === null,
        scheme: subtree.scheme,
        path_prefix: subtree.pathPrefix,
      })),
      host: target.host,
      port: target.port ?? undefined,
      port_is_null: target.port === null,
      scheme: target.scheme,
      path_prefix: target.pathPrefix,
    }),
  });
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

// --- automatic Match & Replace ------------------------------------------

export async function getMatchReplaceRules(): Promise<MatchReplaceRule[]> {
  const data = await request<{ rules: MatchReplaceRule[] }>('/api/match-replace');
  return data.rules ?? [];
}

export async function putMatchReplaceRules(
  rules: MatchReplaceRule[],
): Promise<MatchReplaceRule[]> {
  const data = await request<{ rules: MatchReplaceRule[] }>('/api/match-replace', {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ rules }),
  });
  return data.rules ?? [];
}

export function previewMatchReplace(
  rules: MatchReplaceRule[],
  phase: MatchReplaceRule['phase'],
  raw: string,
): Promise<{ raw: string }> {
  return request('/api/match-replace/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rules, phase, raw }),
  });
}

// --- body display --------------------------------------------------------

export function getBodyDisplaySettings(): Promise<BodyDisplaySettings> {
  return request('/api/body-display');
}

export function setBodyDisplaySettings(
  auto_decompress: boolean,
): Promise<BodyDisplaySettings> {
  return request('/api/body-display', {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ auto_decompress }),
  });
}

// --- WebSocket proxy -----------------------------------------------------

export function getWebSocketState(): Promise<WebSocketState> {
  return request('/api/websockets');
}

export function listWebSocketMessages(before?: number): Promise<{
  items: WebSocketMessage[]; has_more: boolean; next_before: number | null;
}> {
  return request(`/api/websockets/messages?limit=200${before ? `&before=${before}` : ''}`);
}

export function patchWebSocketIntercept(
  patch: Partial<WebSocketInterceptRules>,
): Promise<WebSocketInterceptRules> {
  return request('/api/websockets/intercept', {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  });
}

export function forwardWebSocketMessage(
  id: string,
  content: string,
  encoding: string,
): Promise<{ ok: boolean }> {
  return request(`/api/websockets/${id}/forward`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ content, encoding }),
  });
}

export function dropWebSocketMessage(id: string): Promise<{ ok: boolean }> {
  return request(`/api/websockets/${id}/drop`, { method: 'POST' });
}

export function repeatWebSocketMessage(payload: {
  connection_id: string;
  to_client: boolean;
  content: string;
  encoding: string;
  is_text: boolean;
}): Promise<{ ok: boolean }> {
  return request('/api/websockets/repeat', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });
}

export function clearWebSocketMessages(): Promise<{ ok: boolean }> {
  return request('/api/websockets', { method: 'DELETE' });
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
  regex = false,
): Promise<import('./types').ScopeRule> {
  return request('/api/scope/from-url', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ url, kind, regex }),
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
  /** Include each site's paths, so the tree needs one request not one
   * per host. */
  withPaths = false,
): Promise<{ sites: import('./types').Site[] }> {
  return request(
    `/api/sitemap?in_scope_only=${inScopeOnly}&with_paths=${withPaths}`,
  );
}

export function getSitePaths(
  host: string,
  scheme: string,
  port: number | null,
  options: { limit?: number; offset?: number; pathPrefix?: string; inScopeOnly?: boolean } = {},
): Promise<{ items: import('./types').SitePath[]; count: number }> {
  const params = new URLSearchParams({ host, scheme });
  if (port !== null) params.set('port', String(port));
  else params.set('port_is_null', 'true');
  params.set('limit', String(options.limit ?? 200));
  params.set('offset', String(options.offset ?? 0));
  if (options.pathPrefix) params.set('path_prefix', options.pathPrefix);
  if (options.inScopeOnly) params.set('in_scope_only', 'true');
  return request(`/api/sitemap/paths?${params}`);
}

export function getSiteFolders(
  host: string, scheme: string, port: number | null,
  options: { limit?: number; offset?: number; pathPrefix?: string; inScopeOnly?: boolean } = {},
): Promise<{ items: string[]; has_more: boolean }> {
  const params = new URLSearchParams({ host, scheme });
  if (port !== null) params.set('port', String(port));
  else params.set('port_is_null', 'true');
  params.set('limit', String(options.limit ?? 200));
  params.set('offset', String(options.offset ?? 0));
  if (options.pathPrefix) params.set('path_prefix', options.pathPrefix);
  if (options.inScopeOnly) params.set('in_scope_only', 'true');
  return request(`/api/sitemap/folders?${params}`);
}

export function getEndpoints(
  host?: string,
  inScopeOnly = false,
  limit = 200,
  offset = 0,
): Promise<{ items: import('./types').EndpointGroup[]; count: number }> {
  const params = new URLSearchParams({ in_scope_only: String(inScopeOnly) });
  if (host) params.set('host', host);
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  return request(`/api/endpoints?${params}`);
}

export function getEndpointFlows(
  endpoint: import('./types').EndpointGroup,
  inScopeOnly = false,
  limit = 200,
  offset = 0,
): Promise<{ items: import('./types').SitePath[]; count: number }> {
  const params = new URLSearchParams({
    scheme: endpoint.scheme,
    host: endpoint.host,
    method: endpoint.method,
    template: endpoint.template,
    in_scope_only: String(inScopeOnly),
    limit: String(limit),
    offset: String(offset),
  });
  if (endpoint.port !== null) params.set('port', String(endpoint.port));
  return request(`/api/endpoints/flows?${params}`);
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
  /** Saved sets to use, so a wordlist is not posted with every attack. */
  payload_set_ids?: string[];
  concurrency?: number;
  delay?: number;
}

export interface PayloadSetSummary {
  id: string;
  name: string;
  count: number;
  source: string | null;
  created_at: number;
  updated_at: number;
}

export interface WordlistEntry {
  id: string;
  name: string;
  category: string;
  approx_lines: number;
  url: string;
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
  safe_mode: boolean;
  development_mode: boolean;
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

export function setPluginOrder(
  names: string[],
): Promise<{ items: import('./types').PluginInfo[] }> {
  return request('/api/plugins/order', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(names),
  });
}

export function setPluginAutoReload(
  name: string,
  enabled: boolean,
): Promise<import('./types').PluginInfo> {
  return request(`/api/plugins/${name}/auto-reload?enabled=${enabled}`, {
    method: 'PATCH',
  });
}

export function listPluginContributions(): Promise<
  import('./types').PluginContributionCatalogue
> {
  return request('/api/plugin-contributions');
}

export function getPluginSettings(
  name: string,
): Promise<import('./types').PluginSettings> {
  return request(`/api/plugins/${name}/settings`);
}

export function patchPluginSettings(
  name: string,
  values: Record<string, unknown>,
): Promise<import('./types').PluginSettings> {
  return request(`/api/plugins/${name}/settings`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ values }),
  });
}

export function invokePluginAction(
  actionId: string,
  context: Record<string, unknown>,
): Promise<{ result: unknown }> {
  return request(`/api/plugin-actions/${actionId}/invoke`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ context }),
  });
}

export function installPluginPackage(
  file: File,
): Promise<{ plugin: import('./types').PluginInfo; trust: string }> {
  return request('/api/plugins/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
}

export function installDevelopmentPlugin(
  path: string,
): Promise<{ plugin: import('./types').PluginInfo; development: true }> {
  return request('/api/plugins/install-development', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ path }),
  });
}

export function uninstallPluginPackage(
  name: string,
): Promise<{ id: string; uninstalled: boolean }> {
  return request(`/api/plugins/${name}/package`, { method: 'DELETE' });
}

export function getPluginCatalogue(refresh = false): Promise<import('./types').PluginCatalogue> {
  return request(`/api/plugin-catalogue?refresh=${refresh}`);
}

export function savePluginCatalogueSources(
  sources: import('./types').PluginCatalogueSource[],
): Promise<{ sources: import('./types').PluginCatalogueSource[] }> {
  return request('/api/plugin-catalogue/sources', {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ sources }),
  });
}

export function installCataloguePlugin(
  source: string,
  plugin: string,
  version?: string,
): Promise<{ plugin: import('./types').PluginInfo; version: string }> {
  return request('/api/plugin-catalogue/install', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ source, plugin, version: version || null, enable: true }),
  });
}

export function rollbackPlugin(
  name: string,
  version?: string,
): Promise<{ plugin: import('./types').PluginInfo; version: string }> {
  return request(`/api/plugins/${encodeURIComponent(name)}/rollback`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ version: version || null }),
  });
}

export function pluginUiUrl(name: string, entrypoint: string): string {
  const asset = entrypoint.replace(/^ui\//, '');
  return `${API_BASE}/api/plugin-ui/${encodeURIComponent(name)}/${asset
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
}

export function listIssues(filters: {
  status?: import('./types').IssueStatus | '';
  severity?: import('./types').IssueSeverity | '';
  search?: string;
} = {}): Promise<{
  items: import('./types').Issue[];
  count: number;
  summary: import('./types').IssueSummary;
}> {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.severity) params.set('severity', filters.severity);
  if (filters.search) params.set('search', filters.search);
  return request(`/api/issues?${params}`);
}

export function setIssueStatus(
  id: string,
  status: import('./types').IssueStatus,
): Promise<import('./types').Issue> {
  return request(`/api/issues/${id}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ status }),
  });
}

export function deleteIssue(id: string): Promise<{ id: string; deleted: true }> {
  return request(`/api/issues/${id}`, { method: 'DELETE' });
}

export function getScannerState(): Promise<import('./types').ScannerState> {
  return request('/api/scanner');
}

export function setPassiveScanner(enabled: boolean): Promise<{ passive_enabled: boolean }> {
  return request(`/api/scanner/passive?enabled=${enabled}`, { method: 'PATCH' });
}

export function startActiveScan(
  flowId: string,
  options: { check_ids?: string[]; concurrency?: number; requests_per_second?: number } = {},
): Promise<import('./types').ScanJob> {
  return request(`/api/scanner/active/${encodeURIComponent(flowId)}`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(options),
  });
}

export function stopScanJob(id: string): Promise<import('./types').ScanJob> {
  return request(`/api/scanner/jobs/${id}/stop`, { method: 'POST' });
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

export function getBrowserState(): Promise<import('./types').BrowserState> {
  return request('/api/browser');
}

export function openBrowser(
  url?: string,
): Promise<import('./types').LaunchedBrowser> {
  return request('/api/browser', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(url ? { url } : {}),
  });
}

export function clearBrowserProfile(): Promise<{ cleared: boolean }> {
  return request('/api/browser/profile', { method: 'DELETE' });
}

export function getMcpState(): Promise<import('./types').McpState> {
  return request('/api/mcp');
}

export function setMcpEnabled(
  enabled: boolean,
): Promise<import('./types').McpState> {
  return request('/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
}

export function getListener(): Promise<import('./types').ListenerState> {
  return request('/api/listener');
}

export function getUpstream(): Promise<import('./types').UpstreamState> {
  return request('/api/upstream');
}

export function setUpstream(hops: string[]): Promise<import('./types').UpstreamState> {
  return request('/api/upstream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hops }),
  });
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

export function projectBackupUrl(): string {
  return `${API_BASE}/api/project/backup`;
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

/** Send a project file as a Blob so large captures never need to be
 * parsed and serialized again on the UI thread. */
export function importProjectFile(
  file: File,
): Promise<{ ok: boolean; flows: number; scope: number; workspace: number }> {
  return request('/api/project/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: file,
  });
}

export interface CompactSite {
  scheme: string | null;
  host: string | null;
  port: number | null;
  flows: number;
  content_bytes: number;
  in_scope: boolean;
}

export interface CompactOverview {
  db_bytes: number;
  reclaimable_bytes: number;
  total_flows: number;
  sites: CompactSite[];
}

export interface CompactResult {
  deleted: number;
  before_bytes: number;
  after_bytes: number;
  reclaimed_bytes: number;
  reclaim_error: string | null;
}

export function getCompactOverview(): Promise<CompactOverview> {
  return request('/api/project/compact');
}

export function compactProject(sites: CompactSite[]): Promise<CompactResult> {
  return request('/api/project/compact', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      sites: sites.map(({ scheme, host, port, flows }) => ({ scheme, host, port, flows })),
    }),
  });
}

/** What the copy-as menus can offer, including plugin formats. */
export function listCodegenFormats(): Promise<{
  formats: { kind: string; label: string; source: string }[];
}> {
  return request('/api/codegen/formats');
}

/** Render a request as code.
 *
 * Done on the engine so that the rules about what is a secret, and the
 * formats plugins contribute, live in one place.
 */
export function renderCode(payload: {
  kind: string;
  flow_id?: string;
  url?: string;
  method?: string;
  headers?: string[][];
  body?: string;
}): Promise<{ kind: string; text: string }> {
  return request('/api/codegen', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** Write the CSRF page to disk and open it in the proxied browser.
 *
 * Seeing the forged request land in the history next to the real one is
 * what makes the proof convincing.
 */
export function openCsrfPoc(payload: {
  flow_id?: string;
  url?: string;
  method?: string;
  headers?: string[][];
  body?: string;
}): Promise<{ path: string }> {
  return request('/api/codegen/csrf/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'csrf', ...payload }),
  });
}

export interface AboutInfo {
  version: string;
  commit: string | null;
  commit_short: string | null;
  release: string | null;
  built_at: string | null;
  dirty: boolean;
  source: 'release' | 'development';
}

/** What build this is: version alone does not identify one. */
export function getAbout(): Promise<AboutInfo> {
  return request('/api/about');
}

export type UpdateChannel = 'stable' | 'nightly';

/** One published build, as the release page describes it. */
export interface UpdateRelease {
  channel: UpdateChannel;
  name: string | null;
  tag: string | null;
  version: string | null;
  commit: string | null;
  commit_short: string | null;
  url: string | null;
  published_at: string | null;
  prerelease: boolean;
}

export interface UpdateCheck {
  checked_at: string;
  channel: UpdateChannel;
  current: AboutInfo;
  releases: Record<UpdateChannel, UpdateRelease | null>;
  latest: UpdateRelease | null;
  update_available: boolean;
  /** How it was decided: behind the published build, level with it,
   *  a build GitHub cannot place, or not comparable at all. */
  reason: 'behind' | 'current' | 'different' | 'unknown';
  download_url: string;
}

/** Ask GitHub whether a newer build exists.
 *
 * Only ever on request: a proxy on an isolated network should not reach
 * out on its own, so nothing here runs without someone asking for it.
 */
export function checkUpdates(
  options: { channel?: UpdateChannel; refresh?: boolean } = {},
): Promise<UpdateCheck> {
  const params = new URLSearchParams();
  if (options.channel) params.set('channel', options.channel);
  if (options.refresh) params.set('refresh', 'true');
  const query = params.toString();
  return request(`/api/updates${query ? `?${query}` : ''}`);
}

/** What the desktop shell's updater found, when the build has one.
 *
 * The engine answers "is there a newer build" by comparing commits; this
 * answers the narrower question the shell can act on: is there a signed
 * build it is allowed to install. A build made without a signing key has
 * no updater, and says so, which is why every call here can fail softly.
 */
export interface UpdateOffer {
  version: string;
  current_version: string;
  date: string | null;
  notes: string | null;
}

export interface UpdateProgress {
  downloaded: number;
  /** Null while the server has not said how large the download is. */
  total: number | null;
}

function shell(): { invoke(cmd: string, args?: unknown): Promise<unknown> } | null {
  return (
    (window as unknown as {
      __TAURI_INTERNALS__?: { invoke(cmd: string, args?: unknown): Promise<unknown> };
    }).__TAURI_INTERNALS__ ?? null
  );
}

/** Capture the active Lanius window and copy its image to the OS clipboard. */
export async function captureWindowToClipboard(): Promise<void> {
  const internals = shell();
  if (!internals) throw new Error('Desktop shell is unavailable');
  await internals.invoke('capture_current_window');
}

/** True when the shell can install an update itself. */
export function canInstallUpdates(): boolean {
  return shell() !== null;
}

export async function desktopUpdateCheck(): Promise<UpdateOffer | null> {
  const internals = shell();
  if (!internals) return null;
  return (await internals.invoke('update_check')) as UpdateOffer | null;
}

/** Download, install, and restart onto the new build.
 *
 * Resolves only on the platforms where the app survives its own
 * installer; on Windows the installer closes it, so treat a resolved
 * promise and a vanished window as the same success.
 */
export async function desktopUpdateInstall(): Promise<void> {
  const internals = shell();
  if (!internals) throw new Error('Desktop shell is unavailable');
  await internals.invoke('update_install');
}

export async function desktopUpdateProgress(): Promise<UpdateProgress> {
  const internals = shell();
  if (!internals) return { downloaded: 0, total: null };
  return (await internals.invoke('update_progress')) as UpdateProgress;
}

/** The shell's own version, when running in the desktop app. */
export async function getShellVersion(): Promise<string | null> {
  const internals = (
    window as unknown as {
      __TAURI_INTERNALS__?: { invoke(cmd: string, args?: unknown): Promise<unknown> };
    }
  ).__TAURI_INTERNALS__;
  if (!internals) return null;
  try {
    const info = (await internals.invoke('engine_info')) as {
      shell_version?: string;
    };
    return info.shell_version ?? null;
  } catch {
    // The shell is optional context, not something to fail the page for.
    return null;
  }
}

/** Saved payload sets, without their payloads. */
export function listPayloadSets(): Promise<{ items: PayloadSetSummary[] }> {
  return request('/api/payload-sets');
}

export function savePayloadSet(body: {
  name: string;
  payloads: string;
  source?: string;
}): Promise<PayloadSetSummary> {
  return request('/api/payload-sets', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

export function getPayloadSet(
  id: string,
): Promise<PayloadSetSummary & { payloads: string[] }> {
  return request(`/api/payload-sets/${id}`);
}

export function deletePayloadSet(id: string): Promise<{ ok: boolean }> {
  return request(`/api/payload-sets/${id}`, { method: 'DELETE' });
}

/** Wordlists that can be fetched. A fixed catalogue, not a listing. */
export function listWordlists(): Promise<{
  items: WordlistEntry[];
  ref: string;
}> {
  return request('/api/wordlists');
}

/** Fetch a wordlist and keep it as a payload set. */
export function importWordlist(body: {
  list_id: string;
  name?: string;
}): Promise<PayloadSetSummary> {
  return request('/api/wordlists/import', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

/** Rename a set in place, keeping its id and payloads. */
export function renamePayloadSet(
  id: string,
  name: string,
): Promise<PayloadSetSummary> {
  return request(`/api/payload-sets/${id}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name }),
  });
}

/** Shared types mirroring the engine's flow model (engine/app/db/store.py). */

export interface FlowSummary {
  id: string;
  type: string;
  client_addr: string | null;
  server_addr: string | null;
  scheme: string | null;
  method: string | null;
  host: string | null;
  port: number | null;
  path: string | null;
  query: string | null;
  http_version: string | null;
  request_size: number;
  started_at: number | null;
  status_code: number | null;
  reason: string | null;
  response_size: number;
  response_mime: string | null;
  completed_at: number | null;
  duration_ms: number | null;
  error: string | null;
  source: string;
  comment: string | null;
  /** True when Match & Replace, Intercept, or a plugin changed the request. */
  modified?: boolean;
  auto_modified?: boolean;
}

export interface RequestVariant {
  method: string;
  scheme: string;
  host: string;
  port: number;
  /** Request target including any query string. */
  path: string;
  http_version: string;
  headers: [string, string][];
  body: string;
  charset: string;
  content_encoding: string | null;
  body_decoded: boolean;
  decode_error: string | null;
}

export interface FlowDetail extends FlowSummary {
  request_headers: [string, string][];
  request_body: string | null;
  response_headers: [string, string][] | null;
  response_body: string | null;
  /** How the bytes were read. Worth showing: a page that is not UTF-8
   *  looks wrong if the charset was guessed badly. */
  request_charset?: string;
  response_charset?: string;
  request_content_encoding?: string | null;
  response_content_encoding?: string | null;
  request_body_decoded?: boolean;
  response_body_decoded?: boolean;
  request_decode_error?: string | null;
  response_decode_error?: string | null;
  request_variants?: {
    original: RequestVariant;
    auto_modified: RequestVariant;
    modified: RequestVariant;
  } | null;
}

export interface BodyDisplaySettings {
  auto_decompress: boolean;
}

export interface InterceptRules {
  enabled: boolean;
  intercept_requests: boolean;
  intercept_responses: boolean;
  host_filter: string | null;
}

export interface PausedFlow {
  id: string;
  phase: 'request' | 'response';
  method: string;
  scheme: string;
  host: string;
  port: number;
  path: string;
  http_version: string;
  request_headers: [string, string][];
  request_body: string;
  status_code?: number;
  reason?: string;
  response_headers?: [string, string][];
  response_body?: string;
}

export interface FlowEdits {
  method?: string;
  path?: string;
  request_headers?: [string, string][];
  request_body?: string;
  status_code?: number;
  response_headers?: [string, string][];
  response_body?: string;
}

export type MatchReplacePhase = 'request' | 'response';
export type MatchReplaceTarget = 'url' | 'headers' | 'body';

export interface MatchReplaceRule {
  id: string;
  name: string;
  enabled: boolean;
  phase: MatchReplacePhase;
  target: MatchReplaceTarget;
  match: string;
  replace: string;
  regex: boolean;
  case_sensitive: boolean;
}

export interface WebSocketInterceptRules {
  enabled: boolean;
  client_messages: boolean;
  server_messages: boolean;
}

export interface WebSocketConnection {
  id: string;
  host: string;
  path: string;
  url: string;
  active: boolean;
  started_at: number | null;
}

export interface WebSocketMessage {
  id: string;
  connection_id: string;
  host: string;
  path: string;
  from_client: boolean;
  is_text: boolean;
  timestamp: number;
  size: number;
  content: string;
  encoding: 'utf-8' | 'base64';
  injected: boolean;
  dropped: boolean;
  paused: boolean;
}

export interface WebSocketState {
  rules: WebSocketInterceptRules;
  connections: WebSocketConnection[];
  messages: WebSocketMessage[];
  paused: string[];
}

export interface EngineStatus {
  version: string;
  proxy: { running: boolean; host: string; port: number; error?: string | null };
  flows: number;
  subscribers: number;
  db_path: string;
  intercept: InterceptRules;
  paused: number;
  /** One entry per configured proxy mode. A mode can fail while the
   *  engine as a whole stays up. */
  modes?: ProxyModeStatus[];
  /** Whether OS-level capture of this machine is usable. On macOS it
   *  needs the user to approve a system extension first. */
  local_capture?: LocalCaptureState;
}

export interface ProxyModeStatus {
  spec: string;
  running: boolean;
  listening: boolean;
  error: string | null;
}

export interface LocalCaptureState {
  supported: boolean;
  approved: boolean;
  detail: string | null;
  /** The configured intercept spec, or null when capture is off. */
  spec?: string | null;
  /** The OS redirector is a process-wide singleton that cannot always be
   *  reconfigured in place, so a change may only take effect on restart. */
  restart_required?: boolean;
}

export type EngineEvent =
  | { type: 'hello'; data: { version: string } }
  | { type: 'flow.request' | 'flow.response' | 'flow.error'; data: FlowSummary }
  | { type: 'flows.cleared'; data: Record<string, never> }
  | { type: 'intercept.paused'; data: PausedFlow }
  | { type: 'intercept.resolved'; data: { id: string; action: string } }
  | { type: 'intercept.rules'; data: InterceptRules }
  | { type: 'match_replace.changed'; data: { rules: MatchReplaceRule[] } }
  | { type: 'body_display.changed'; data: BodyDisplaySettings }
  | { type: 'websocket.started' | 'websocket.ended'; data: WebSocketConnection }
  | { type: 'websocket.message' | 'websocket.intercepted'; data: WebSocketMessage }
  | { type: 'websocket.resolved'; data: { id: string; action: string } }
  | { type: 'websocket.rules'; data: WebSocketInterceptRules }
  | { type: 'websocket.cleared'; data: Record<string, never> }
  | { type: 'engine.started' | 'engine.stopped'; data: Record<string, unknown> }
  | { type: 'engine.local_capture_blocked'; data: LocalCaptureState }
  | {
      type: 'engine.mode_failed';
      data: {
        spec: string;
        running: boolean;
        listening: boolean;
        error: string | null;
      };
    }
  | { type: 'scope.changed'; data: ScopeState }
  | { type: 'intruder.started' | 'intruder.finished'; data: AttackSummary }
  | {
      type: 'intruder.result';
      data: { attack_id: string; result: AttackResult };
    };

export interface FlowFilters {
  host?: string;
  method?: string;
  statusCode?: number;
  search?: string;
  /** Checkbox filters: several at once, rather than a single choice. */
  methods?: string[];
  /** By class (2 for 2xx), because that is the useful unit. */
  statusClasses?: number[];
  extensions?: string[];
  excludeExtensions?: string[];
  inScopeOnly?: boolean;
}

// --- target / scope (M4) --------------------------------------------------

export interface ScopeRule {
  id: number | null;
  kind: 'include' | 'exclude';
  host: string;
  path: string;
  protocol: 'any' | 'http' | 'https';
  port: number | null;
  match_type: 'glob' | 'regex';
  enabled: boolean;
}

export interface ScopeState {
  rules: ScopeRule[];
  restrict_capture: boolean;
}

export interface Site {
  scheme: string;
  host: string;
  port: number | null;
  flows: number;
  paths: number;
  last_seen: number | null;
  in_scope: boolean;
  /** Present when the site map was asked for paths as well. */
  path_items?: SitePath[];
}

export interface SitePath {
  id: string;
  method: string;
  path: string;
  query: string | null;
  status_code: number | null;
  response_size: number;
  started_at: number | null;
}

export interface EndpointGroup {
  key: string;
  method: string;
  scheme: string;
  host: string;
  port: number | null;
  template: string;
  count: number;
  path_params: string[];
  query_params: string[];
  statuses: number[];
  examples: string[];
  last_seen: number | null;
}

// --- intruder (M5) --------------------------------------------------------

export type AttackType =
  | 'sniper'
  | 'battering_ram'
  | 'pitchfork'
  | 'cluster_bomb';

export interface AttackResult {
  index: number;
  payloads: string[];
  status_code: number | null;
  length: number;
  duration_ms: number | null;
  error: string | null;
  flow_id: string | null;
}

export interface AttackSummary {
  id: string;
  attack_type: AttackType;
  url: string;
  status: 'pending' | 'running' | 'completed' | 'stopped' | 'failed';
  total: number;
  completed: number;
  started_at: number;
  finished_at: number | null;
  error: string | null;
}

export interface Attack extends AttackSummary {
  results: AttackResult[];
}

// --- plugins (M7) ---------------------------------------------------------

export interface PluginInfo {
  name: string;
  path: string;
  enabled: boolean;
  loaded: boolean;
  error: string | null;
  description: string | null;
  version: string | null;
  author: string | null;
  hooks: string[];
}

// --- dashboard ------------------------------------------------------------

export interface DashboardHost {
  host: string;
  scheme: string | null;
  port: number | null;
  flows: number;
  errors: number;
  bytes: number;
  last_seen: number | null;
}

export interface Dashboard {
  flows: number;
  hosts: number;
  bytes: number;
  avg_duration_ms: number | null;
  errors: number;
  pending: number;
  first_seen: number | null;
  last_seen: number | null;
  span_seconds: number;
  recent_flows: number;
  recent_window_seconds: number;
  status_groups: Record<string, number>;
  methods: { method: string; count: number }[];
  top_hosts: DashboardHost[];
  proxy: { running: boolean; host: string; port: number };
  intercept_enabled: boolean;
  paused: number;
  version: string;
  modes: ProxyModeStatus[];
  local_capture: LocalCaptureState;
}

// --- upstream TLS ---------------------------------------------------------

export interface TlsProfileOption {
  id: string;
  label: string;
}

export interface BrowserState {
  available: boolean;
  name: string | null;
  profile: string;
  /** True when HTTPS will work without installing the CA by hand. */
  ca_trusted: boolean;
}

export interface LaunchedBrowser {
  name: string;
  path: string;
  pid: number;
  profile: string;
  proxy: string;
  ca_trusted: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  /** True when the tool changes something rather than just reading. */
  writes: boolean;
}

export interface McpState {
  available: boolean;
  enabled: boolean;
  url: string;
  host: string;
  port: number;
  tools: McpTool[];
}

export interface BindAddress {
  host: string;
  label: string;
}

export interface ListenerState {
  host: string;
  port: number;
  running: boolean;
  /** Why the proxy is not listening, when it failed to start. */
  error: string | null;
  /** True when bound beyond loopback, so other machines can reach it. */
  exposed: boolean;
  addresses: BindAddress[];
}

export interface TlsState {
  profile: string;
  custom_ciphers: string | null;
  ciphers: string | null;
  available: TlsProfileOption[];
}

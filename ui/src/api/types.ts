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

export type ResponsePreview =
  | { kind: 'html'; text: string }
  | { kind: 'image'; mime: string; data: string }
  | { kind: 'pdf'; data: string }
  | { kind: 'text'; text: string }
  | { kind: 'csv'; rows: string[][] }
  | { kind: 'archive'; total_entries: number; entries: { name: string; size: number; compressed_size: number; directory: boolean; text: string | null }[] }
  | { kind: 'spreadsheet'; total_sheets: number; sheets: { name: string; rows: { number: string; cells: { ref: string; value: string }[] }[] }[] }
  | { kind: 'unavailable'; reason: string };

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
export type MatchReplaceTarget = 'url' | 'headers' | 'body' | 'message';

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
  seq?: number;
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
  has_more?: boolean;
  next_before?: number | null;
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
  | { type: 'fuzzer.started' | 'fuzzer.finished'; data: RunSummary }
  | {
      type: 'fuzzer.result';
      data: { run_id: string; result: RunResult };
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

// --- fuzzer (M5) --------------------------------------------------------

export type RunMode =
  | 'single_position'
  | 'shared_payload'
  | 'lockstep'
  | 'cartesian';

export interface RunResult {
  index: number;
  payloads: string[];
  status_code: number | null;
  length: number;
  duration_ms: number | null;
  error: string | null;
  flow_id: string | null;
}

export interface RunSummary {
  id: string;
  mode: RunMode;
  url: string;
  status: 'pending' | 'running' | 'completed' | 'stopped' | 'failed';
  total: number;
  completed: number;
  started_at: number;
  finished_at: number | null;
  error: string | null;
}

export interface FuzzRun extends RunSummary {
  results: RunResult[];
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
  order: number;
  auto_reload: boolean;
  sdk_api_version: string | null;
  contributions: PluginContributionCounts;
  package: PluginPackageInfo | null;
  ui: { views: PluginUiView[] } | null;
}

export interface PluginPackageInfo {
  schema: number;
  id: string;
  name: string;
  permissions: string[];
  signature_present: boolean;
  trust: 'trusted' | 'unsigned' | 'development' | 'unmanaged';
  development: boolean;
  source: 'archive' | 'catalogue' | 'development' | 'unmanaged';
  catalog_source: string | null;
}

export interface PluginCatalogueSource {
  id: string;
  title: string;
  url: string;
  public_key: string;
  key_id: string | null;
  enabled: boolean;
}

export interface PluginCatalogueRelease {
  version: string;
  url: string;
  sha256: string;
  package_key_id: string;
  compatibility: { lanius: string; sdk: string };
  published_at?: string;
  yanked?: boolean;
  compatible: boolean;
  revoked: boolean;
  revocation_reason: string | null;
}

export interface PluginCatalogueItem {
  id: string;
  name: string;
  description?: string;
  author?: string;
  homepage?: string;
  categories?: string[];
  source: string;
  source_title: string;
  releases: PluginCatalogueRelease[];
  latest_version: string | null;
  installed_version: string | null;
  update_available: boolean;
  rollback_versions: string[];
}

export interface PluginCatalogue {
  sources: PluginCatalogueSource[];
  items: PluginCatalogueItem[];
  errors: Record<string, string>;
  refreshed: boolean;
}

export interface PluginUiView {
  id: string;
  title: string;
  entrypoint: string;
}

export interface PluginContributionCounts {
  actions?: number;
  codecs?: number;
  payload_generators?: number;
  payload_processors?: number;
  settings?: number;
  passive_scanners?: number;
  active_scanners?: number;
}

export interface PluginSettingField {
  key: string;
  title: string;
  kind: 'string' | 'boolean' | 'integer' | 'number' | 'enum';
  default: string | boolean | number | null;
  description: string | null;
  scope: 'project' | 'user';
  choices: string[];
}

export interface PluginSettings {
  plugin: string;
  fields: PluginSettingField[];
  values: Record<string, unknown>;
}

export interface PluginContributionDiagnostic {
  id: string;
  kind: string | null;
  title: string | null;
  calls: number;
  errors: number;
  total_ms: number;
  average_ms: number;
  max_ms: number;
  last_ms: number;
  last_called_at: number | null;
  last_error: string | null;
  consecutive_errors: number;
  suspended: boolean;
}

export interface PluginLogEntry {
  timestamp: number;
  level: string;
  message: string;
}

export interface PluginDiagnostics {
  plugin: string;
  contributions: PluginContributionDiagnostic[];
  logs: PluginLogEntry[];
}

export type PluginActionLocation =
  | 'global'
  | 'history'
  | 'flow'
  | 'request'
  | 'response'
  | 'replay'
  | 'fuzzer';

export interface PluginActionContribution {
  id: string;
  plugin: string;
  title: string;
  description: string | null;
  locations: PluginActionLocation[];
}

export interface PluginContributionCatalogue {
  actions: PluginActionContribution[];
  codecs: Array<{
    id: string;
    plugin: string;
    title: string;
    directions: Array<'encode' | 'decode'>;
  }>;
  payload_generators: Array<{
    id: string;
    plugin: string;
    title: string;
    description: string | null;
  }>;
  payload_processors: Array<{
    id: string;
    plugin: string;
    title: string;
    description: string | null;
  }>;
  settings: Array<{
    id: string;
    plugin: string;
    title: string;
    kind: PluginSettingField['kind'];
    scope: PluginSettingField['scope'];
  }>;
  passive_scanners: ScannerCheck[];
  active_scanners: ScannerCheck[];
}

export type IssueSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export type IssueStatus = 'open' | 'resolved' | 'false_positive';

export interface Issue {
  id: string;
  fingerprint: string;
  plugin_id: string;
  check_id: string;
  scan_mode: 'passive' | 'active';
  title: string;
  severity: IssueSeverity;
  confidence: 'tentative' | 'firm' | 'certain';
  status: IssueStatus;
  detail: string;
  remediation: string | null;
  url: string | null;
  host: string | null;
  path: string | null;
  parameter: string | null;
  flow_id: string | null;
  evidence: Record<string, unknown> | null;
  first_seen: number;
  last_seen: number;
  occurrences: number;
}

export interface IssueSummary {
  total: number;
  by_severity: Record<IssueSeverity, number>;
  by_status: Record<IssueStatus, number>;
}

export interface ScannerCheck {
  id: string;
  plugin: string;
  title: string;
  description: string | null;
  mode: 'passive' | 'active';
}

export interface ScanJob {
  id: string;
  flow_id: string;
  check_ids: string[];
  concurrency: number;
  requests_per_second: number;
  total: number;
  completed: number;
  requests: number;
  issues: number;
  status: 'pending' | 'running' | 'completed' | 'stopped' | 'failed';
  error: string | null;
  started_at: number;
  finished_at: number | null;
}

export interface ScannerState {
  passive_enabled: boolean;
  passive_checks: ScannerCheck[];
  active_checks: ScannerCheck[];
  jobs: ScanJob[];
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

export interface UpstreamState {
  enabled: boolean;
  hops: string[];
  url: string | null;
}

export interface TlsState {
  profile: string;
  custom_ciphers: string | null;
  ciphers: string | null;
  available: TlsProfileOption[];
}

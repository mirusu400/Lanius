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
}

export interface FlowDetail extends FlowSummary {
  request_headers: [string, string][];
  request_body: string | null;
  response_headers: [string, string][] | null;
  response_body: string | null;
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

export interface EngineStatus {
  version: string;
  proxy: { running: boolean; host: string; port: number };
  flows: number;
  subscribers: number;
  db_path: string;
  intercept: InterceptRules;
  paused: number;
}

export type EngineEvent =
  | { type: 'hello'; data: { version: string } }
  | { type: 'flow.request' | 'flow.response' | 'flow.error'; data: FlowSummary }
  | { type: 'flows.cleared'; data: Record<string, never> }
  | { type: 'intercept.paused'; data: PausedFlow }
  | { type: 'intercept.resolved'; data: { id: string; action: string } }
  | { type: 'intercept.rules'; data: InterceptRules }
  | { type: 'engine.started' | 'engine.stopped'; data: Record<string, unknown> }
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

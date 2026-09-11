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
  | { type: 'engine.started' | 'engine.stopped'; data: Record<string, unknown> };

export interface FlowFilters {
  host?: string;
  method?: string;
  statusCode?: number;
  search?: string;
}

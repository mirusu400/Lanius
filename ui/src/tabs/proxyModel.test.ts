import { describe, expect, it } from 'vitest';

import type { FlowSummary } from '../api/types';
import {
  MAX_FLOWS,
  formatBytes,
  formatDuration,
  formatUrl,
  matchesFilters,
  mergeFlow,
  statusClass,
} from './proxyModel';

function flow(overrides: Partial<FlowSummary> = {}): FlowSummary {
  return {
    id: 'a',
    type: 'http',
    client_addr: null,
    server_addr: null,
    scheme: 'https',
    method: 'GET',
    host: 'example.com',
    port: 443,
    path: '/api/items',
    query: 'page=1',
    http_version: 'HTTP/2.0',
    request_size: 0,
    started_at: 1000,
    status_code: 200,
    reason: 'OK',
    response_size: 512,
    response_mime: 'application/json',
    completed_at: 1001,
    duration_ms: 42,
    error: null,
    source: 'proxy',
    comment: null,
    ...overrides,
  };
}

describe('mergeFlow', () => {
  it('prepends a new flow', () => {
    const result = mergeFlow([flow({ id: 'old' })], flow({ id: 'new' }));
    expect(result.map((f) => f.id)).toEqual(['new', 'old']);
  });

  it('updates an existing flow in place (request -> response)', () => {
    const pending = flow({ id: 'a', status_code: null });
    const result = mergeFlow([pending], flow({ id: 'a', status_code: 404 }));
    expect(result).toHaveLength(1);
    expect(result[0].status_code).toBe(404);
  });

  it('bounds the list at MAX_FLOWS', () => {
    const many = Array.from({ length: MAX_FLOWS }, (_, i) =>
      flow({ id: `f${i}` }),
    );
    expect(mergeFlow(many, flow({ id: 'new' }))).toHaveLength(MAX_FLOWS);
  });
});

describe('matchesFilters', () => {
  it('accepts everything with empty filters', () => {
    expect(matchesFilters(flow(), {})).toBe(true);
  });

  it('filters by host substring', () => {
    expect(matchesFilters(flow(), { host: 'example' })).toBe(true);
    expect(matchesFilters(flow(), { host: 'other' })).toBe(false);
  });

  it('filters by method case-insensitively', () => {
    expect(matchesFilters(flow(), { method: 'get' })).toBe(true);
    expect(matchesFilters(flow(), { method: 'POST' })).toBe(false);
  });

  it('filters by status code', () => {
    expect(matchesFilters(flow(), { statusCode: 200 })).toBe(true);
    expect(matchesFilters(flow(), { statusCode: 500 })).toBe(false);
  });

  it('ignores NaN status filters', () => {
    expect(matchesFilters(flow(), { statusCode: Number.NaN })).toBe(true);
  });

  it('searches host, path and query', () => {
    expect(matchesFilters(flow(), { search: 'ITEMS' })).toBe(true);
    expect(matchesFilters(flow(), { search: 'page=1' })).toBe(true);
    expect(matchesFilters(flow(), { search: 'zzz' })).toBe(false);
  });
});

describe('formatters', () => {
  it('omits default ports in URLs', () => {
    expect(formatUrl(flow())).toBe('https://example.com/api/items?page=1');
    expect(formatUrl(flow({ scheme: 'http', port: 80, query: null }))).toBe(
      'http://example.com/api/items',
    );
    expect(formatUrl(flow({ port: 8443, query: null }))).toBe(
      'https://example.com:8443/api/items',
    );
  });

  it('maps status codes to classes', () => {
    expect(statusClass(null)).toBe('status-pending');
    expect(statusClass(200)).toBe('status-2xx');
    expect(statusClass(301)).toBe('status-3xx');
    expect(statusClass(404)).toBe('status-4xx');
    expect(statusClass(503)).toBe('status-5xx');
  });

  it('formats bytes and durations', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(formatDuration(null)).toBe('');
    expect(formatDuration(42.4)).toBe('42 ms');
    expect(formatDuration(1500)).toBe('1.50 s');
  });
});

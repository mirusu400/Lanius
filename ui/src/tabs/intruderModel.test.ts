import { describe, expect, it } from 'vitest';

import type { AttackResult, FlowDetail, FlowSummary } from '../api/types';
import {
  MARKER,
  addMarker,
  clearMarkers,
  countPositions,
  estimateRequests,
  markOutliers,
  parsePayloads,
  requiredSets,
  templateFromFlow,
} from './intruderModel';

const M = MARKER;

function result(index: number, length: number): AttackResult {
  return {
    index,
    payloads: [`p${index}`],
    status_code: 200,
    length,
    duration_ms: 1,
    error: null,
    flow_id: `f${index}`,
  };
}

describe('countPositions', () => {
  it('counts balanced marker pairs', () => {
    expect(countPositions(`GET /?a=${M}1${M}&b=${M}2${M} HTTP/1.1`)).toBe(2);
    expect(countPositions('GET / HTTP/1.1')).toBe(0);
  });

  it('reports unbalanced markers as -1', () => {
    expect(countPositions(`GET /?a=${M}1 HTTP/1.1`)).toBe(-1);
  });
});

describe('addMarker', () => {
  it('wraps the selected range', () => {
    expect(addMarker('GET /a?q=word HTTP/1.1', 9, 13)).toBe(
      `GET /a?q=${M}word${M} HTTP/1.1`,
    );
  });

  it('ignores empty selections', () => {
    expect(addMarker('abc', 1, 1)).toBe('abc');
  });
});

describe('clearMarkers', () => {
  it('removes every marker but keeps the values', () => {
    expect(clearMarkers(`GET /?a=${M}1${M} HTTP/1.1`)).toBe(
      'GET /?a=1 HTTP/1.1',
    );
  });
});

describe('parsePayloads', () => {
  it('splits lines and drops blanks', () => {
    expect(parsePayloads('a\n\n b \nc\n')).toEqual(['a', 'b', 'c']);
  });

  it('handles an empty wordlist', () => {
    expect(parsePayloads('   ')).toEqual([]);
  });
});

describe('estimateRequests', () => {
  const sets = [
    ['a', 'b'],
    ['x', 'y', 'z'],
  ];

  it('matches the engine for each attack type', () => {
    expect(estimateRequests('sniper', 2, sets)).toBe(4);
    expect(estimateRequests('battering_ram', 3, sets)).toBe(2);
    expect(estimateRequests('pitchfork', 2, sets)).toBe(2);
    expect(estimateRequests('cluster_bomb', 2, sets)).toBe(6);
  });

  it('returns 0 without positions or sets', () => {
    expect(estimateRequests('sniper', 0, sets)).toBe(0);
    expect(estimateRequests('sniper', 2, [])).toBe(0);
  });

  it('returns 0 when multi-set modes lack sets', () => {
    expect(estimateRequests('cluster_bomb', 2, [['a']])).toBe(0);
    expect(estimateRequests('pitchfork', 3, sets)).toBe(0);
  });
});

describe('requiredSets', () => {
  it('single-set modes need one set', () => {
    expect(requiredSets('sniper', 3)).toBe(1);
    expect(requiredSets('battering_ram', 3)).toBe(1);
  });

  it('multi-set modes need one set per position', () => {
    expect(requiredSets('pitchfork', 3)).toBe(3);
    expect(requiredSets('cluster_bomb', 2)).toBe(2);
    expect(requiredSets('cluster_bomb', 0)).toBe(1);
  });
});

describe('templateFromFlow', () => {
  const flow: FlowSummary = {
    id: 'f1',
    type: 'http',
    client_addr: null,
    server_addr: null,
    scheme: 'https',
    method: 'POST',
    host: 'api.test',
    port: 443,
    path: '/login',
    query: 'next=/a',
    http_version: 'HTTP/1.1',
    request_size: 0,
    started_at: 1,
    status_code: 200,
    reason: 'OK',
    response_size: 0,
    response_mime: null,
    completed_at: null,
    duration_ms: null,
    error: null,
    source: 'proxy',
    comment: null,
  };

  it('builds a raw template and origin', () => {
    const detail = {
      ...flow,
      request_headers: [['Host', 'api.test']],
      request_body: 'u=a',
      response_headers: null,
      response_body: null,
    } as unknown as FlowDetail;
    const built = templateFromFlow(flow, detail);
    expect(built.url).toBe('https://api.test');
    expect(built.template).toContain('POST /login?next=/a HTTP/1.1');
    expect(built.template.endsWith('u=a')).toBe(true);
  });

  it('works without detail', () => {
    expect(templateFromFlow(flow).template).toContain('Host: api.test');
  });
});

describe('markOutliers', () => {
  it('flags responses whose length differs from the majority', () => {
    const results = [
      result(0, 100),
      result(1, 100),
      result(2, 100),
      result(3, 250),
    ];
    expect([...markOutliers(results)]).toEqual([3]);
  });

  it('returns nothing when there is no dominant length', () => {
    expect(markOutliers([result(0, 1), result(1, 2), result(2, 3)]).size).toBe(
      0,
    );
  });

  it('needs at least three results', () => {
    expect(markOutliers([result(0, 1), result(1, 9)]).size).toBe(0);
  });
});

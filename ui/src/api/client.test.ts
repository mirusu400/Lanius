import { describe, expect, it } from 'vitest';

import { buildFlowQuery } from './client';

describe('buildFlowQuery', () => {
  it('always sets a limit', () => {
    expect(buildFlowQuery({}, 50)).toBe('limit=50');
  });

  it('includes provided filters only', () => {
    const q = new URLSearchParams(
      buildFlowQuery({ host: 'a.com', method: 'POST', statusCode: 404 }, 10),
    );
    expect(q.get('host')).toBe('a.com');
    expect(q.get('method')).toBe('POST');
    expect(q.get('status_code')).toBe('404');
    expect(q.get('search')).toBeNull();
  });

  it('skips NaN status codes', () => {
    expect(buildFlowQuery({ statusCode: Number.NaN })).not.toContain('status');
  });

  it('encodes search terms', () => {
    expect(buildFlowQuery({ search: 'a b&c' })).toContain('search=a+b%26c');
  });
});

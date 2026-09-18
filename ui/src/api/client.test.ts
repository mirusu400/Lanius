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

describe('buildFlowQuery with the new filters', () => {
  it('repeats a key for each method', () => {
    // The engine reads a list. Joining them would ask for one method
    // literally named "GET,POST".
    expect(buildFlowQuery({ methods: ['GET', 'POST'] })).toContain(
      'methods=GET&methods=POST',
    );
  });

  it('sends status classes as numbers', () => {
    expect(buildFlowQuery({ statusClasses: [4, 5] })).toContain(
      'status_classes=4&status_classes=5',
    );
  });

  it('sends extensions both ways round', () => {
    const query = buildFlowQuery({
      extensions: ['json'],
      excludeExtensions: ['png', 'css'],
    });
    expect(query).toContain('extensions=json');
    expect(query).toContain('exclude_extensions=png&exclude_extensions=css');
  });

  it('sends the scope flag only when it is on', () => {
    expect(buildFlowQuery({ inScopeOnly: true })).toContain('in_scope_only=true');
    expect(buildFlowQuery({ inScopeOnly: false })).not.toContain('in_scope_only');
  });

  it('leaves empty lists out', () => {
    expect(buildFlowQuery({ methods: [], statusClasses: [] }, 50)).toBe('limit=50');
  });
});

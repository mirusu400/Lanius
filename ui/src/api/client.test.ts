import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildFlowQuery, getStatus, patchFlowAnnotation, setApiToken } from './client';

afterEach(() => {
  setApiToken('');
  vi.unstubAllGlobals();
});

describe('desktop API authentication', () => {
  it('sends annotation edits as JSON to the engine', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: 'flow-1', bookmarked: false, annotation_color: 'purple',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await patchFlowAnnotation('flow-1', { annotation_color: 'purple' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/api/flows/flow-1/annotation');
    expect(init.method).toBe('PATCH');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ annotation_color: 'purple' });
  });
  it('adds the session token to REST requests', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    setApiToken('desktop-secret');

    await getStatus();

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('Authorization')).toBe(
      'Bearer desktop-secret',
    );
  });
});

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

  it('passes the history snapshot anchor with later pages', () => {
    expect(buildFlowQuery({}, 200, 200, 123)).toContain('offset=200&anchor=123');
  });

  it('uses a cursor for a sequential page', () => {
    const q = new URLSearchParams(buildFlowQuery({}, 200, 200, 123, '[1,42]'));
    expect(q.get('cursor')).toBe('[1,42]');
    expect(q.has('offset')).toBe(false);
  });
});

describe('buildFlowQuery with the new filters', () => {
  it('sends bookmark and highlight filters', () => {
    const query = new URLSearchParams(buildFlowQuery({ bookmarkedOnly: true, annotationColor: 'blue' }));
    expect(query.get('bookmarked_only')).toBe('true');
    expect(query.get('annotation_color')).toBe('blue');
  });
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

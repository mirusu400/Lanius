import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState, Text } from '@codemirror/state';
import { prepareCachedTextDocument } from './preparedTextDocument';
import { TextDocumentCache, textDocumentCache } from './textDocumentCache';
import { prepareTextDocument, type TextDocumentResult, type TextDocumentTask } from './textDocumentModel';

const SOURCE = 'HTTP/1.1 200 OK\r\n\r\n한글😀e\u0301\r' + 'x'.repeat(1024 * 1024) + '\nTAIL';
let workers: WorkerDouble[];

class WorkerDouble {
  onmessage: ((event: MessageEvent<TextDocumentResult>) => void) | null = null;
  terminate = vi.fn(() => { this.onmessage = null; });
  postMessage = vi.fn((task: TextDocumentTask) => {
    queueMicrotask(() => this.onmessage?.({ data: prepareTextDocument(task) } as MessageEvent<TextDocumentResult>));
  });
  constructor() { workers.push(this); }
}

beforeEach(() => {
  workers = [];
  textDocumentCache.clear();
  textDocumentCache.setLimitMiB(32);
  vi.stubGlobal('Worker', WorkerDouble);
});
afterEach(() => { textDocumentCache.clear(); vi.unstubAllGlobals(); });

describe('prepared document reuse', () => {
  it('reopens an exact document without a second worker and retains full selection text', async () => {
    const first = await prepareCachedTextDocument(SOURCE, new AbortController().signal);
    const second = await prepareCachedTextDocument(SOURCE, new AbortController().signal);
    expect(second).toBe(first);
    expect(workers).toHaveLength(1);
    const state = EditorState.create({ doc: second, extensions: [EditorState.lineSeparator.of('\n')] });
    expect(state.sliceDoc(0, state.doc.length)).toBe(SOURCE);
  });

  it('prepares changed contents even when their lengths match', async () => {
    const first = await prepareCachedTextDocument(SOURCE, new AbortController().signal);
    const changed = SOURCE.replace('TAIL', 'EDIT');
    const second = await prepareCachedTextDocument(changed, new AbortController().signal);
    expect(second).not.toBe(first);
    expect(second.sliceString(second.length - 4)).toBe('EDIT');
    expect(workers).toHaveLength(2);
  });

  it('does not repopulate a cleared project cache from an in-flight preparation', async () => {
    const first = prepareCachedTextDocument(SOURCE, new AbortController().signal);
    textDocumentCache.clear();
    await first;
    expect(textDocumentCache.get(SOURCE)).toBeUndefined();
    await prepareCachedTextDocument(SOURCE, new AbortController().signal);
    expect(workers).toHaveLength(2);
  });

  it('does not cache cancelled work or return a cache hit to an aborted caller', async () => {
    const controller = new AbortController();
    const pending = prepareCachedTextDocument(SOURCE, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(textDocumentCache.get(SOURCE)).toBeUndefined();
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    await prepareCachedTextDocument(SOURCE, new AbortController().signal);
    await expect(prepareCachedTextDocument(SOURCE, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(workers).toHaveLength(2);
  });
});

describe('document memory budget', () => {
  const remember = (cache: TextDocumentCache, source: string) => {
    const doc = Text.of(source.split('\n'));
    cache.put(source, doc, cache.generation);
    return doc;
  };

  it('evicts the least recently used document at the entry limit', () => {
    const cache = new TextDocumentCache(1024 * 1024, 2);
    const a = remember(cache, 'a');
    remember(cache, 'b');
    expect(cache.get('a')).toBe(a);
    remember(cache, 'c');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(a);
    expect(cache.get('c')).toBeDefined();
  });

  it('bounds estimated memory and skips oversized documents without evicting useful entries', () => {
    const cache = new TextDocumentCache(9000);
    const a = remember(cache, 'a');
    remember(cache, 'b');
    remember(cache, 'x'.repeat(2000));
    expect(cache.get('a')).toBe(a);
    expect(cache.get('x'.repeat(2000))).toBeUndefined();
    remember(cache, 'c');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(a);
    expect(cache.get('c')).toBeDefined();
  });

  it('accounts for line-heavy documents as well as source bytes', () => {
    const cache = new TextDocumentCache(9000);
    remember(cache, '\n'.repeat(100));
    expect(cache.get('\n'.repeat(100))).toBeUndefined();
  });

  it('defaults to 32 MiB and immediately evicts older entries when shrinking', () => {
    const cache = new TextDocumentCache();
    expect(cache.getSnapshot().maxBytes).toBe(32 * 1024 * 1024);
    const a = 'a'.repeat(200000), b = 'b'.repeat(200000);
    remember(cache, a);
    const newest = remember(cache, b);
    cache.setLimitMiB(1);
    expect(cache.get(a)).toBeUndefined();
    expect(cache.get(b)).toBe(newest);
    expect(cache.getSnapshot().bytes).toBeLessThanOrEqual(1024 * 1024);
  });

  it('disables caching at zero and prevents old work from refilling after clearing', () => {
    const cache = new TextDocumentCache();
    remember(cache, 'a');
    const oldGeneration = cache.generation;
    cache.setLimitMiB(0);
    expect(cache.getSnapshot()).toEqual({ bytes: 0, count: 0, maxBytes: 0 });
    remember(cache, 'b');
    expect(cache.get('b')).toBeUndefined();
    cache.setLimitMiB(32);
    cache.put('late', Text.of(['late']), oldGeneration);
    expect(cache.get('late')).toBeUndefined();
    remember(cache, 'c');
    expect(cache.get('c')).toBeDefined();
  });
});

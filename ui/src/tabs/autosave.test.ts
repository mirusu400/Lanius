/** Autosave.
 *
 * Tabs are written to the engine as you work. The payload includes
 * response bodies, so it can be hundreds of kilobytes, and a store emits
 * on every change including ones that leave the saved shape identical.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { autosave as startAutosave, flushAutosaves, replaceWorkspace } from './autosave';
import { addFuzzerDraft, ensureFuzzerDraft, getFuzzerWorkspace, mergeFuzzerWorkspace, newFuzzerDraft, resetTarget, setFuzzerWorkspace, subscribeFuzzerWorkspace } from './fuzzerStore';

let puts: { key: string; value: unknown }[] = [];
let stored: Record<string, unknown> = {};
const disposers: Array<() => void> = [];

function autosave<T>(...args: Parameters<typeof startAutosave<T>>) {
  const dispose = startAutosave<T>(...args);
  disposers.push(dispose);
  return dispose;
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers({ 'Content-Type': 'application/json' }),
  } as unknown as Response;
}

beforeEach(() => {
  resetTarget();
  puts = [];
  stored = {};
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const key = url.split('/').pop() ?? '';
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { value: unknown };
        puts.push({ key, value: body.value });
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ value: stored[key] ?? null });
    }),
  );
});

afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A minimal store: emits on subscribe, then whenever told to. */
function makeStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<(v: T) => void>();
  return {
    get: () => value,
    subscribe(listener: (v: T) => void) {
      listeners.add(listener);
      listener(value);
      return () => listeners.delete(listener);
    },
    set(next: T) {
      value = next;
      for (const listener of listeners) listener(value);
    },
  };
}

describe('autosave', () => {
  it('keeps a request sent to Fuzzer before its saved workspace loads', async () => {
    const old = newFuzzerDraft('http://saved.test');
    const sent = newFuzzerDraft('http://sent.test');
    let finishRead!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>((resolve) => { finishRead = resolve; }));
    autosave('fuzzer', subscribeFuzzerWorkspace, setFuzzerWorkspace, undefined, resetTarget, mergeFuzzerWorkspace);
    ensureFuzzerDraft();
    addFuzzerDraft(sent);

    finishRead(jsonResponse({ value: { tabs: [old], activeId: old.id } }));
    await vi.runAllTimersAsync();

    expect(getFuzzerWorkspace().tabs.map((tab) => tab.url)).toEqual(['http://saved.test', 'http://sent.test']);
    expect(getFuzzerWorkspace().activeId).toBe(sent.id);
    expect(puts.at(-1)?.value).toEqual(getFuzzerWorkspace());
  });
  it('drops an untouched starter tab when a saved Fuzzer workspace arrives', async () => {
    const old = newFuzzerDraft('http://saved.test');
    let finishRead!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>((resolve) => { finishRead = resolve; }));
    autosave('fuzzer', subscribeFuzzerWorkspace, setFuzzerWorkspace, undefined, resetTarget, mergeFuzzerWorkspace);
    ensureFuzzerDraft();

    finishRead(jsonResponse({ value: { tabs: [old], activeId: old.id } }));
    await vi.runAllTimersAsync();

    expect(getFuzzerWorkspace().tabs.map((tab) => tab.url)).toEqual(['http://saved.test']);
    expect(getFuzzerWorkspace().activeId).toBe(old.id);
  });
  it('does not write when nothing actually changed', async () => {
    // Stores emit freely, and the payload can be large. Re-sending an
    // identical one is pure cost on every keystroke elsewhere.
    const store = makeStore({ tabs: ['a'] });
    autosave('replay', (l) => store.subscribe(l), () => {});

    // Let the load settle and the first save go out, so what follows is
    // measured against a known baseline.
    await vi.runAllTimersAsync();
    store.set({ tabs: ['a', 'x'] });
    await vi.runAllTimersAsync();
    puts = [];

    // Same content, new object: a store cannot tell these apart.
    store.set({ tabs: ['a', 'x'] });
    await vi.runAllTimersAsync();
    expect(puts).toHaveLength(0);

    store.set({ tabs: ['a', 'b'] });
    await vi.runAllTimersAsync();
    expect(puts).toHaveLength(1);
    expect(puts[0].value).toEqual({ tabs: ['a', 'b'] });
  });

  it('writes once for a burst of changes', async () => {
    const store = makeStore({ n: 0 });
    autosave('replay', (l) => store.subscribe(l), () => {});
    await vi.runOnlyPendingTimersAsync();
    puts = [];

    for (let n = 1; n <= 20; n += 1) store.set({ n });
    await vi.runAllTimersAsync();

    // Typing twenty characters is one save, carrying the final state.
    expect(puts).toHaveLength(1);
    expect(puts[0].value).toEqual({ n: 20 });
  });

  it('restores what was saved, and does not write it straight back', async () => {
    stored.replay = { tabs: ['restored'] };
    const restored: unknown[] = [];
    const store = makeStore({ tabs: [] as string[] });

    autosave('replay', (l) => store.subscribe(l), (v) => restored.push(v));
    await vi.runAllTimersAsync();

    expect(restored).toEqual([{ tabs: ['restored'] }]);
    // Loading must not count as a change, or a slow load would overwrite
    // the saved state with the empty one it replaced.
    expect(puts).toHaveLength(0);
  });

  it('falls back to a legacy workspace key when the new key is empty', async () => {
    stored.transform = { tabs: ['legacy decoder'] };
    const restored: unknown[] = [];
    const store = makeStore({ tabs: [] as string[] });

    autosave(
      'decoder',
      (listener) => store.subscribe(listener),
      (value) => restored.push(value),
      'transform',
    );
    await vi.runAllTimersAsync();

    expect(restored).toEqual([{ tabs: ['legacy decoder'] }]);
    expect(puts).toHaveLength(0);
  });

  it('flushes the latest edit before changing projects', async () => {
    const store = makeStore({ tabs: [] as string[] });
    const dispose = autosave('replay', (l) => store.subscribe(l), () => {});
    await vi.runOnlyPendingTimersAsync();

    store.set({ tabs: ['unsaved edit'] });
    await flushAutosaves();
    expect(puts).toEqual([{ key: 'replay', value: { tabs: ['unsaved edit'] } }]);
    dispose();
  });

  it('replaces open tabs without an old debounce overwriting the import', async () => {
    stored.replay = { tabs: ['old'] };
    const store = makeStore({ tabs: [] as string[] });
    autosave('replay', store.subscribe, store.set);
    await vi.runAllTimersAsync();
    store.set({ tabs: ['old unsaved edit'] });

    await replaceWorkspace(async () => {
      stored.replay = { tabs: ['imported'] };
    });
    await vi.runAllTimersAsync();
    expect(store.get()).toEqual({ tabs: ['imported'] });
    expect(puts).toEqual([]);

    store.set({ tabs: ['imported', 'new edit'] });
    await flushAutosaves();
    expect(puts).toEqual([{ key: 'replay', value: { tabs: ['imported', 'new edit'] } }]);
  });

  it('waits for a write already on the wire before replacing the database', async () => {
    const store = makeStore({ n: 0 });
    autosave('replay', store.subscribe, store.set);
    await vi.runAllTimersAsync();
    let finishWrite!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(async () => new Promise<Response>((resolve) => {
      finishWrite = resolve;
    }));
    store.set({ n: 1 });
    await vi.advanceTimersByTimeAsync(800);
    const replace = vi.fn(async () => { stored.replay = { n: 2 }; });
    const pending = replaceWorkspace(replace);
    await vi.advanceTimersByTimeAsync(0);
    expect(replace).not.toHaveBeenCalled();

    finishWrite(jsonResponse({ ok: true }));
    await pending;
    expect(replace).toHaveBeenCalledOnce();
    expect(store.get()).toEqual({ n: 2 });
  });

  it('clears old tabs when the imported workspace has no saved tabs', async () => {
    stored.replay = { tabs: ['old'] };
    const store = makeStore({ tabs: [] as string[] });
    const reset = () => store.set({ tabs: [] });
    autosave('replay', store.subscribe, store.set, undefined, reset);
    await vi.runAllTimersAsync();

    await replaceWorkspace(async () => { stored = {}; });
    expect(store.get()).toEqual({ tabs: [] });
    await flushAutosaves();
    expect(puts).toEqual([]);
  });

  it('keeps and saves the previous draft if the import fails', async () => {
    const store = makeStore({ n: 0 });
    autosave('replay', store.subscribe, store.set);
    await vi.runAllTimersAsync();
    store.set({ n: 3 });

    await expect(replaceWorkspace(async () => { throw new Error('bad import'); })).rejects.toThrow('bad import');
    await vi.runAllTimersAsync();
    expect(store.get()).toEqual({ n: 3 });
    expect(puts).toEqual([{ key: 'replay', value: { n: 3 } }]);
  });

  it('waits for an import when flushing for app shutdown', async () => {
    const store = makeStore({ n: 0 });
    autosave('replay', store.subscribe, store.set);
    await vi.runAllTimersAsync();
    store.set({ n: 1 });
    let finishImport!: () => void;
    const pending = replaceWorkspace(async () => {
      await new Promise<void>((resolve) => { finishImport = resolve; });
      stored.replay = { n: 2 };
    });
    const flushed = vi.fn();
    const closing = flushAutosaves().then(flushed);
    await vi.advanceTimersByTimeAsync(1000);
    expect(flushed).not.toHaveBeenCalled();
    expect(puts).toEqual([]);

    finishImport();
    await pending;
    await closing;
    expect(store.get()).toEqual({ n: 2 });
    expect(flushed).toHaveBeenCalledOnce();
    expect(puts).toEqual([]);
  });

  it('blocks stale saves after a failed reload and retries restoration on close', async () => {
    const store = makeStore({ n: 0 });
    autosave('replay', store.subscribe, store.set);
    await vi.runAllTimersAsync();
    store.set({ n: 1 });
    await expect(replaceWorkspace(async () => {
      stored.replay = { n: 2 };
      vi.mocked(fetch).mockRejectedValueOnce(new Error('reload offline'));
    })).rejects.toThrow('reload offline');
    store.set({ n: 9 });
    await vi.runAllTimersAsync();
    expect(puts).toEqual([]);

    await flushAutosaves();
    expect(store.get()).toEqual({ n: 2 });
    expect(puts).toEqual([]);
  });
});

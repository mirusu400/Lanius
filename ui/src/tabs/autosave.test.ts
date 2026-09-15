/** Autosave.
 *
 * Tabs are written to the engine as you work. The payload includes
 * response bodies, so it can be hundreds of kilobytes, and a store emits
 * on every change including ones that leave the saved shape identical.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { autosave } from './autosave';

let puts: { key: string; value: unknown }[] = [];
let stored: Record<string, unknown> = {};

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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A minimal store: emits on subscribe, then whenever told to. */
function makeStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<(v: T) => void>();
  return {
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
  it('does not write when nothing actually changed', async () => {
    // Stores emit freely, and the payload can be large. Re-sending an
    // identical one is pure cost on every keystroke elsewhere.
    const store = makeStore({ tabs: ['a'] });
    autosave('repeater', (l) => store.subscribe(l), () => {});

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
    autosave('repeater', (l) => store.subscribe(l), () => {});
    await vi.runOnlyPendingTimersAsync();
    puts = [];

    for (let n = 1; n <= 20; n += 1) store.set({ n });
    await vi.runAllTimersAsync();

    // Typing twenty characters is one save, carrying the final state.
    expect(puts).toHaveLength(1);
    expect(puts[0].value).toEqual({ n: 20 });
  });

  it('restores what was saved, and does not write it straight back', async () => {
    stored.repeater = { tabs: ['restored'] };
    const restored: unknown[] = [];
    const store = makeStore({ tabs: [] as string[] });

    autosave('repeater', (l) => store.subscribe(l), (v) => restored.push(v));
    await vi.runAllTimersAsync();

    expect(restored).toEqual([{ tabs: ['restored'] }]);
    // Loading must not count as a change, or a slow load would overwrite
    // the saved state with the empty one it replaced.
    expect(puts).toHaveLength(0);
  });
});

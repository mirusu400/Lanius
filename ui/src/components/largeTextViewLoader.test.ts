import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const moduleLoaded = vi.hoisted(() => vi.fn());
vi.mock('./LargeTextView', () => { moduleLoaded(); return { default: () => null }; });

beforeEach(() => { vi.resetModules(); moduleLoaded.mockClear(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('waits for idle time and shares one import with an explicit open', async () => {
  let idle: IdleRequestCallback | undefined;
  const requestIdle = vi.fn((callback: IdleRequestCallback) => { idle = callback; return 42; });
  vi.stubGlobal('requestIdleCallback', requestIdle);
  vi.stubGlobal('cancelIdleCallback', vi.fn());
  const { scheduleLargeTextViewPreload, loadLargeTextView } = await import('./largeTextViewLoader');
  scheduleLargeTextViewPreload();
  expect(moduleLoaded).not.toHaveBeenCalled();
  expect(requestIdle).toHaveBeenCalledWith(expect.any(Function), { timeout: 1500 });
  idle!({ didTimeout: false, timeRemaining: () => 30 });
  const opened = loadLargeTextView();
  expect(loadLargeTextView()).toBe(opened);
  await opened;
  expect(moduleLoaded).toHaveBeenCalledOnce();
  scheduleLargeTextViewPreload();
  expect(requestIdle).toHaveBeenCalledOnce();
});

it('cancels the idle callback when history is hidden or unmounted', async () => {
  vi.stubGlobal('requestIdleCallback', vi.fn(() => 42));
  const cancelIdle = vi.fn();
  vi.stubGlobal('cancelIdleCallback', cancelIdle);
  const { scheduleLargeTextViewPreload } = await import('./largeTextViewLoader');
  const cancel = scheduleLargeTextViewPreload();
  cancel();
  expect(cancelIdle).toHaveBeenCalledWith(42);
  expect(moduleLoaded).not.toHaveBeenCalled();
});

it('uses a cancellable delayed fallback when idle callbacks are unavailable', async () => {
  vi.stubGlobal('requestIdleCallback', undefined);
  const { scheduleLargeTextViewPreload, loadLargeTextView } = await import('./largeTextViewLoader');
  scheduleLargeTextViewPreload()();
  await vi.advanceTimersByTimeAsync(250);
  expect(moduleLoaded).not.toHaveBeenCalled();
  scheduleLargeTextViewPreload();
  await vi.advanceTimersByTimeAsync(249);
  expect(moduleLoaded).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await loadLargeTextView();
  expect(vi.getTimerCount()).toBe(0);
  scheduleLargeTextViewPreload();
  expect(vi.getTimerCount()).toBe(0);
});

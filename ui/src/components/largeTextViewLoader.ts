let pending: Promise<typeof import('./LargeTextView')> | undefined;

/** Lazy rendering and idle preloading share the same bundled module. */
export function loadLargeTextView() {
  if (!pending) {
    pending = import('./LargeTextView').catch(error => {
      pending = undefined;
      throw error;
    });
  }
  return pending;
}

export function scheduleLargeTextViewPreload(): () => void {
  if (pending) return () => {};
  // A failed speculative load must neither surface an error nor prevent a
  // subsequent explicit open from retrying it. Only bundled code is loaded.
  const preload = () => { void loadLargeTextView().catch(() => {}); };
  if (typeof window.requestIdleCallback === 'function') {
    const idle = window.requestIdleCallback(preload, { timeout: 1500 });
    return () => window.cancelIdleCallback(idle);
  }
  const timer = window.setTimeout(preload, 250);
  return () => window.clearTimeout(timer);
}

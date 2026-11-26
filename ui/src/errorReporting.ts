/**
 * Record UI errors with the engine, so a traceback is still there when
 * someone asks for it. Reports stay on this machine; the user decides
 * whether to send them (Settings > About > Diagnostics).
 */

import { reportClientError } from './api/client';

/** The same error tends to fire on every render or every poll. */
const DUPLICATE_WINDOW_MS = 60_000;
/** A broken loop must not turn into a stream of reports. */
const MAX_REPORTS_PER_SESSION = 30;

/** Browser noise, not a bug in Lanius. */
const IGNORED = [/^ResizeObserver loop/, /^Script error\.?$/];

const recent = new Map<string, number>();
let sent = 0;

function describe(error: unknown): { kind: string; message: string; stack: string } {
  if (error instanceof Error) {
    return { kind: error.name || 'Error', message: error.message, stack: error.stack ?? '' };
  }
  return { kind: 'Error', message: typeof error === 'string' ? error : String(error), stack: '' };
}

/** Report one error. Returns whether it was sent. */
export function reportError(error: unknown, where: string, componentStack = ''): boolean {
  const { kind, message, stack } = describe(error);
  if (IGNORED.some((pattern) => pattern.test(message))) return false;
  const key = `${kind}\u0000${message}\u0000${stack}`;
  const now = Date.now();
  for (const [seen, at] of recent) {
    if (now - at >= DUPLICATE_WINDOW_MS) recent.delete(seen);
  }
  if (recent.has(key) || sent >= MAX_REPORTS_PER_SESSION) return false;
  recent.set(key, now);
  sent += 1;
  void reportClientError({ kind, message, stack, component_stack: componentStack, where });
  return true;
}

/** Install the global listeners; returns a function that removes them. */
export function installErrorReporting(target: Window = window): () => void {
  const onError = (event: ErrorEvent) => {
    // A failed <img> or <script> load has no error object and no stack.
    if (!event.error && !event.message) return;
    reportError(event.error ?? event.message, 'window.onerror');
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    reportError(event.reason, 'unhandledrejection');
  };
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  return () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
  };
}

/** For tests. */
export function resetErrorReporting(): void {
  recent.clear();
  sent = 0;
}

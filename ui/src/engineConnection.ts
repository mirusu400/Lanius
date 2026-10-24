import { useSyncExternalStore } from 'react';

export interface EngineConnectionState {
  status: 'online' | 'offline';
  /** The low-level reason from the last request. Kept for deduplicating UI errors. */
  error: string | null;
  /** Increments after an outage recovers so stale load states can refresh. */
  recovery: number;
}

const ONLINE: EngineConnectionState = { status: 'online', error: null, recovery: 0 };
let state = ONLINE;
const listeners = new Set<() => void>();

function publish(next: EngineConnectionState): void {
  if (state.status === next.status && state.error === next.error && state.recovery === next.recovery) return;
  state = next;
  listeners.forEach((listener) => listener());
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** A rejected local engine request, distinct from an HTTP error response. */
export class EngineUnavailableError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super(errorMessage(cause));
    this.name = 'EngineUnavailableError';
    this.cause = cause;
  }
}

export function engineRequestFailed(cause: unknown): EngineUnavailableError {
  const error = cause instanceof EngineUnavailableError
    ? cause
    : new EngineUnavailableError(cause);
  publish({ status: 'offline', error: error.message, recovery: state.recovery });
  return error;
}

/** Any HTTP response proves that the local engine can be reached. */
export function engineResponded(): void {
  publish({
    status: 'online',
    error: null,
    recovery: state.recovery + (state.status === 'offline' ? 1 : 0),
  });
}

export function getEngineConnection(): EngineConnectionState {
  return state;
}

export function subscribeEngineConnection(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useEngineConnection(): EngineConnectionState {
  return useSyncExternalStore(
    subscribeEngineConnection,
    getEngineConnection,
    getEngineConnection,
  );
}

/**
 * True when a toast repeats the same transport failure already represented by
 * the global connection banner. HTTP errors do not put the store offline and
 * remain visible at their point of action.
 */
export function repeatsEngineConnectionError(message: string): boolean {
  if (state.status !== 'offline' || !state.error) return false;
  return message.toLocaleLowerCase().includes(state.error.toLocaleLowerCase());
}

/** Reset transient process state when tests or a new shell session start. */
export function resetEngineConnection(): void {
  publish(ONLINE);
}

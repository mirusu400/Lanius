/** Shared store so the Proxy tab can push a request into Fuzzer. */

import type { FlowDetail, FlowSummary } from '../api/types';
import { templateFromFlow } from './fuzzerModel';

export interface FuzzerTarget {
  url: string;
  template: string;
  seq: number;
}

type Listener = (target: FuzzerTarget | null) => void;

let current: FuzzerTarget | null = null;
let seq = 0;
const listeners = new Set<Listener>();

export function subscribeTarget(listener: Listener): () => void {
  listeners.add(listener);
  listener(current);
  return () => listeners.delete(listener);
}

/** Send a request the user has already edited, as raw text.
 *
 * Replay holds an edited request rather than a captured flow, so there
 * was no way to carry it into Fuzzer without going back to the history
 * and losing the edits.
 */
export function sendTextToFuzzer(url: string, template: string): FuzzerTarget {
  seq += 1;
  current = { url, template, seq };
  for (const listener of listeners) listener(current);
  return current;
}

export function sendToFuzzer(
  flow: FlowSummary,
  detail?: FlowDetail | null,
): FuzzerTarget {
  seq += 1;
  const { url, template } = templateFromFlow(flow, detail);
  current = { url, template, seq };
  for (const listener of listeners) listener(current);
  return current;
}

export function resetTarget(): void {
  current = null;
  seq = 0;
  for (const listener of listeners) listener(current);
}

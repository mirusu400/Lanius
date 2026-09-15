/** Shared store so the Proxy tab can push a request into Intruder. */

import type { FlowDetail, FlowSummary } from '../api/types';
import { templateFromFlow } from './intruderModel';

export interface IntruderTarget {
  url: string;
  template: string;
  seq: number;
}

type Listener = (target: IntruderTarget | null) => void;

let current: IntruderTarget | null = null;
let seq = 0;
const listeners = new Set<Listener>();

export function subscribeTarget(listener: Listener): () => void {
  listeners.add(listener);
  listener(current);
  return () => listeners.delete(listener);
}

/** Send a request the user has already edited, as raw text.
 *
 * Repeater holds an edited request rather than a captured flow, so there
 * was no way to carry it into Intruder without going back to the history
 * and losing the edits.
 */
export function sendTextToIntruder(url: string, template: string): IntruderTarget {
  seq += 1;
  current = { url, template, seq };
  for (const listener of listeners) listener(current);
  return current;
}

export function sendToIntruder(
  flow: FlowSummary,
  detail?: FlowDetail | null,
): IntruderTarget {
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

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

/** Tiny pub/sub store so the Proxy tab can push requests into Replay. */

import type { FlowDetail, FlowSummary } from '../api/types';
import { tabFromFlow, withUniqueIds, type ReplayTab } from './replayModel';
import { asMessage } from '../i18n/message';

type Listener = (tabs: ReplayTab[]) => void;

let tabs: ReplayTab[] = [];
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener(tabs);
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  listener(tabs);
  return () => listeners.delete(listener);
}

export function getTabs(): ReplayTab[] {
  return tabs;
}

export function setTabs(next: ReplayTab[]): void {
  // Restored projects may carry an error saved before errors became
  // messages, when the translated sentence was stored directly.
  tabs = withUniqueIds(
    next.map((tab) => ({ ...tab, error: asMessage(tab.error) })),
  );
  emit();
}

export function addTab(tab: ReplayTab): ReplayTab {
  tabs = [...tabs, tab];
  emit();
  return tab;
}

export function updateTab(id: string, patch: Partial<ReplayTab>): void {
  tabs = tabs.map((t) => (t.id === id ? { ...t, ...patch } : t));
  emit();
}

export function removeTab(id: string): void {
  tabs = tabs.filter((t) => t.id !== id);
  emit();
}

/** "Send to Replay" from the Proxy history. */
export function sendToReplay(
  flow: FlowSummary,
  detail?: FlowDetail | null,
): ReplayTab {
  return addTab(tabFromFlow(flow, detail));
}

/** Test helper. */
export function resetTabs(): void {
  tabs = [];
  emit();
}

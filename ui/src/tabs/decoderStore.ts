/** Decoder tab store.
 *
 * Tabs live outside the component for the same reason Repeater's do:
 * React unmounts a tab when you switch away, so component state would
 * throw away every payload the moment you looked at the Proxy history.
 */

import { emptyDecoderTab, type DecoderTabState } from './decoderModel';

type Listener = (tabs: DecoderTabState[], activeId: string) => void;

let tabs: DecoderTabState[] = [emptyDecoderTab()];
let activeId = tabs[0].id;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener(tabs, activeId);
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  listener(tabs, activeId);
  return () => {
    listeners.delete(listener);
  };
}

export function getDecoderTabs(): DecoderTabState[] {
  return tabs;
}

export function getActiveId(): string {
  return activeId;
}

export function setActiveId(id: string): void {
  if (!tabs.some((tab) => tab.id === id)) return;
  activeId = id;
  emit();
}

export function addDecoderTab(): DecoderTabState {
  const tab = emptyDecoderTab();
  tabs = [...tabs, tab];
  activeId = tab.id;
  emit();
  return tab;
}

export function patchDecoderTab(id: string, patch: Partial<DecoderTabState>): void {
  tabs = tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab));
  emit();
}

export function removeDecoderTab(id: string): void {
  const next = tabs.filter((tab) => tab.id !== id);
  // Never leave the tab with nothing to show.
  tabs = next.length > 0 ? next : [emptyDecoderTab()];
  if (id === activeId) activeId = tabs[tabs.length - 1].id;
  emit();
}

/** Test helper. */
export function resetDecoderTabs(): void {
  tabs = [emptyDecoderTab()];
  activeId = tabs[0].id;
  emit();
}

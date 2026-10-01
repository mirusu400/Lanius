/** Tiny pub/sub store so the Proxy tab can push requests into Replay. */

import type { FlowDetail, FlowSummary } from '../api/types';
import {
  REPLAY_HISTORY_LIMIT,
  canStepReplayHistory,
  replaySnapshot,
  tabFromFlow,
  trimResponse,
  withUniqueIds,
  type ReplayResponse,
  type ReplaySnapshot,
  type ReplayTab,
} from './replayModel';
import { asMessage, type Message } from '../i18n/message';

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
  tabs = withUniqueIds(next.map((tab) => {
    const history = (tab.history ?? (tab.response ? [{
      ...replaySnapshot(tab),
      sentAt: 0,
    }] : [])).slice(-REPLAY_HISTORY_LIMIT).map((entry) => ({
      ...entry,
      response: entry.response ? trimResponse(entry.response) : null,
      error: asMessage(entry.error),
    }));
    const dropped = (tab.history?.length ?? history.length) - history.length;
    const showingDropped = tab.historyIndex != null && tab.historyIndex < dropped;
    let index: number | null = null;
    if (history.length > 0 && !showingDropped) {
      if (tab.historyIndex === undefined) index = history.length - 1;
      else if (tab.historyIndex !== null) {
        index = Math.max(0, Math.min(history.length - 1, tab.historyIndex - dropped));
      }
    }
    const draft = showingDropped ? replaySnapshot(tab) : tab.draft ?? null;
    return {
      ...tab,
      sending: false,
      error: asMessage(tab.error),
      history,
      historyIndex: index,
      draft: draft ? { ...draft, error: asMessage(draft.error) } : null,
    };
  }));
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

/** Editing a sent pair starts a draft; the recorded request stays immutable. */
export function editReplayTab(id: string, patch: Partial<Pick<ReplayTab, 'url' | 'text'>>): void {
  tabs = tabs.map((tab) => {
    if (tab.id !== id) return tab;
    const edited = { ...tab, ...patch, historyIndex: null };
    const draft = tab.historyIndex == null ? tab.draft ?? null : replaySnapshot(edited);
    return { ...edited, draft };
  });
  emit();
}

/** Move through sent pairs and restore an unsent draft after the newest one. */
export function stepReplayHistory(id: string, step: -1 | 1): void {
  tabs = tabs.map((tab) => {
    if (tab.id !== id || !canStepReplayHistory(tab, step)) return tab;
    const history = tab.history ?? [];
    const position = tab.historyIndex ?? history.length;
    const next = position + step;
    const draft = tab.historyIndex === null ? replaySnapshot(tab) : tab.draft ?? null;
    const snapshot = next === history.length ? draft : history[next];
    if (!snapshot) return tab;
    return { ...tab, ...snapshot, historyIndex: next === history.length ? null : next, draft };
  });
  emit();
}

/** Record the exact request and its outcome, even if the editor changed in flight. */
export function finishReplaySend(
  id: string,
  request: Pick<ReplaySnapshot, 'url' | 'text'>,
  startedIndex: number | null,
  response: ReplayResponse | null,
  error: Message | null,
): void {
  tabs = tabs.map((tab) => {
    if (tab.id !== id) return tab;
    const fullHistory = [...(tab.history ?? []), { ...request, response, error, sentAt: Date.now() }];
    const dropped = Math.max(0, fullHistory.length - REPLAY_HISTORY_LIMIT);
    const history = fullHistory.slice(-REPLAY_HISTORY_LIMIT);
    const stillShowingRequest = tab.url === request.url && tab.text === request.text
      && (tab.historyIndex ?? null) === startedIndex;
    if (stillShowingRequest) {
      return {
        ...tab, ...request, response, error, history,
        historyIndex: history.length - 1, draft: null, sending: false,
      };
    }
    if (tab.historyIndex != null && tab.historyIndex < dropped) {
      return { ...tab, history, historyIndex: null, draft: replaySnapshot(tab), sending: false };
    }
    return {
      ...tab, history, sending: false,
      historyIndex: tab.historyIndex == null ? null : tab.historyIndex - dropped,
    };
  });
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

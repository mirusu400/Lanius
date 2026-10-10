/** Shared store so the Proxy tab can push a request into Fuzzer. */

import type { FlowDetail, FlowSummary, FuzzRun } from '../api/types';
import { templateFromFlow } from './fuzzerModel';
import { nextTabId } from './replayModel';
import { notifyRequestTransferred } from '../requestTransfers';
import type { RunMode } from '../api/types';

export interface FuzzerTarget {
  url: string;
  template: string;
  seq: number;
}

type Listener = (target: FuzzerTarget | null) => void;

let current: FuzzerTarget | null = null;
let seq = 0;
const listeners = new Set<Listener>();

export interface FuzzerDraft {
  id: string;
  url: string;
  template: string;
  mode: RunMode;
  payloadText: string[];
  concurrency: number;
  delay: number;
  runId: string | null;
}

export interface FuzzerWorkspace {
  tabs: FuzzerDraft[];
  activeId: string | null;
}

let workspace: FuzzerWorkspace = { tabs: [], activeId: null };
let workspaceEpoch = 0;
let autoDraftId: string | null = null;
const workspaceListeners = new Set<(value: FuzzerWorkspace) => void>();
const emitWorkspace = () => {
  for (const listener of workspaceListeners) listener(workspace);
};

export function getFuzzerWorkspace(): FuzzerWorkspace { return workspace; }
/** Replaced project workspaces may reuse tab ids; remount their editors. */
export function getFuzzerWorkspaceEpoch(): number { return workspaceEpoch; }
export function subscribeFuzzerWorkspace(listener: (value: FuzzerWorkspace) => void): () => void {
  workspaceListeners.add(listener);
  listener(workspace);
  return () => workspaceListeners.delete(listener);
}
export function setFuzzerWorkspace(next: FuzzerWorkspace): void {
  const tabs = (next.tabs ?? []).map((tab) => ({ ...tab, runId: tab.runId ?? null }));
  workspace = {
    tabs,
    activeId: tabs.some((tab) => tab.id === next.activeId) ? next.activeId : tabs.at(-1)?.id ?? null,
  };
  workspaceEpoch += 1;
  autoDraftId = null;
  emitWorkspace();
}
/** Preserve requests sent while the first workspace read was pending. */
export function mergeFuzzerWorkspace(saved: FuzzerWorkspace, changed: FuzzerWorkspace): FuzzerWorkspace {
  const byId = new Map(saved.tabs.map((tab) => [tab.id, tab]));
  for (const tab of changed.tabs) {
    // The Fuzzer screen creates a starter tab on first visit. If the saved
    // workspace has tabs, discard that untouched placeholder on restore.
    const pristineAutoDraft = tab.id === autoDraftId && saved.tabs.length > 0 &&
      tab.url === DEFAULT_URL && tab.template === DEFAULT_TEMPLATE &&
      tab.mode === 'single_position' && tab.payloadText.length === 1 &&
      tab.payloadText[0] === 'a\nb\nc' && tab.concurrency === 5 &&
      tab.delay === 0 && tab.runId === null;
    if (!pristineAutoDraft) byId.set(tab.id, tab);
  }
  const tabs = [...byId.values()];
  return {
    tabs,
    activeId: tabs.some((tab) => tab.id === changed.activeId)
      ? changed.activeId
      : saved.activeId,
  };
}
const DEFAULT_URL = 'http://example.com';
const DEFAULT_TEMPLATE = 'GET /?q={{test}} HTTP/1.1\nHost: example.com\n\n';
export function newFuzzerDraft(url = DEFAULT_URL, template = DEFAULT_TEMPLATE): FuzzerDraft {
  return {
    id: nextTabId(), url, template, mode: 'single_position',
    payloadText: ['a\nb\nc'], concurrency: 5, delay: 0, runId: null,
  };
}
export function ensureFuzzerDraft(): void {
  if (workspace.tabs.length) return;
  const draft = newFuzzerDraft();
  autoDraftId = draft.id;
  addFuzzerDraft(draft);
}
export function addFuzzerDraft(draft: FuzzerDraft): void {
  workspace = { tabs: [...workspace.tabs, draft], activeId: draft.id };
  emitWorkspace();
}
export function patchFuzzerDraft(id: string, patch: Partial<FuzzerDraft>): void {
  const tab = workspace.tabs.find((entry) => entry.id === id);
  if (!tab || Object.entries(patch).every(([key, value]) => tab[key as keyof FuzzerDraft] === value)) return;
  workspace = { ...workspace, tabs: workspace.tabs.map((entry) => entry.id === id ? { ...entry, ...patch } : entry) };
  emitWorkspace();
}
export function selectFuzzerDraft(id: string): void {
  workspace = { ...workspace, activeId: id };
  emitWorkspace();
}
export function removeFuzzerDraft(id: string): void {
  if (id === autoDraftId) autoDraftId = null;
  const tabs = workspace.tabs.filter((tab) => tab.id !== id);
  workspace = { tabs, activeId: workspace.activeId === id ? tabs.at(-1)?.id ?? null : workspace.activeId };
  emitWorkspace();
}
export function openFuzzerRun(run: FuzzRun): void {
  const existing = workspace.tabs.find((tab) => tab.runId === run.id);
  if (existing) {
    selectFuzzerDraft(existing.id);
    return;
  }
  addFuzzerDraft({
    ...newFuzzerDraft(run.url, run.template),
    mode: run.mode,
    payloadText: run.payload_sets.map((items) => items.join('\n')),
    concurrency: run.speed.concurrency,
    delay: run.speed.delay,
    runId: run.id,
  });
}

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
  addFuzzerDraft(newFuzzerDraft(url, template));
  for (const listener of listeners) listener(current);
  notifyRequestTransferred('Fuzzer');
  return current;
}

export function sendToFuzzer(
  flow: FlowSummary,
  detail?: FlowDetail | null,
): FuzzerTarget {
  const { url, template } = templateFromFlow(flow, detail);
  return sendTextToFuzzer(url, template);
}

export function resetTarget(): void {
  current = null;
  seq = 0;
  workspace = { tabs: [], activeId: null };
  workspaceEpoch += 1;
  autoDraftId = null;
  emitWorkspace();
  for (const listener of listeners) listener(current);
}

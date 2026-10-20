/** Persistence shared by the workspace, project import and app shutdown. */
import { autosave } from './autosave';
import { getTabs, resetTabs, setTabs, subscribe as subscribeReplay } from './replayStore';
import { getDecoderTabs, resetDecoderTabs, setDecoderTabs, subscribe as subscribeDecoder } from './decoderStore';
import { mergeFuzzerWorkspace, resetTarget, setFuzzerWorkspace, subscribeFuzzerWorkspace } from './fuzzerStore';
import { resetTextDocumentCacheSettings, restoreTextDocumentCacheSettings, subscribeTextDocumentCacheSettings } from '../components/textDocumentCacheSettings';

function mergeTabs<T extends { id: string }>(saved: T[], changed: T[]): T[] {
  const tabs = new Map(saved.map((tab) => [tab.id, tab]));
  for (const tab of changed) tabs.set(tab.id, tab);
  return [...tabs.values()];
}

export function startWorkspaceAutosaves(): () => void {
  resetTextDocumentCacheSettings();
  const initialDecoderTabs = getDecoderTabs();
  const first = initialDecoderTabs[0];
  const decoderPlaceholder = initialDecoderTabs.length === 1 && first.input === ''
    && first.steps.length === 0 && !first.title && !first.renamed && first.view === 'text'
    ? first : null;
  const stops = [
    autosave('textDocumentCache', subscribeTextDocumentCacheSettings, restoreTextDocumentCacheSettings,
      undefined, resetTextDocumentCacheSettings, (_saved, changed) => changed),
    autosave('replay', (listener) => subscribeReplay(() => listener(getTabs())), setTabs, 'repeater', resetTabs, mergeTabs),
    autosave(
      'decoder',
      (listener) => subscribeDecoder(() => listener(getDecoderTabs())),
      (value: ReturnType<typeof getDecoderTabs>) => value.length ? setDecoderTabs(value) : resetDecoderTabs(),
      'transform',
      resetDecoderTabs,
      // Preserve edits and explicitly added tabs during the initial read.
      // An untouched startup placeholder should not join a saved workspace.
      (saved, changed) => mergeTabs(saved, saved.length
        ? changed.filter((tab) => tab !== decoderPlaceholder)
        : changed),
    ),
    autosave('fuzzer', subscribeFuzzerWorkspace, setFuzzerWorkspace, undefined, resetTarget, mergeFuzzerWorkspace),
  ];
  return () => {
    stops.forEach((stop) => stop());
    resetTextDocumentCacheSettings();
  };
}

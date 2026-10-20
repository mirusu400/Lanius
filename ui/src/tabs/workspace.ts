/** Persistence shared by the workspace, project import and app shutdown. */
import { autosave } from './autosave';
import { getTabs, resetTabs, setTabs, subscribe as subscribeReplay } from './replayStore';
import { getDecoderTabs, resetDecoderTabs, setDecoderTabs, subscribe as subscribeDecoder } from './decoderStore';
import { mergeFuzzerWorkspace, resetTarget, setFuzzerWorkspace, subscribeFuzzerWorkspace } from './fuzzerStore';
import { resetTextDocumentCacheSettings, restoreTextDocumentCacheSettings, subscribeTextDocumentCacheSettings } from '../components/textDocumentCacheSettings';

export function startWorkspaceAutosaves(): () => void {
  resetTextDocumentCacheSettings();
  const stops = [
    autosave('textDocumentCache', subscribeTextDocumentCacheSettings, restoreTextDocumentCacheSettings,
      undefined, resetTextDocumentCacheSettings, (_saved, changed) => changed),
    autosave('replay', (listener) => subscribeReplay(() => listener(getTabs())), setTabs, 'repeater', resetTabs),
    autosave(
      'decoder',
      (listener) => subscribeDecoder(() => listener(getDecoderTabs())),
      (value: ReturnType<typeof getDecoderTabs>) => value.length ? setDecoderTabs(value) : resetDecoderTabs(),
      'transform',
      resetDecoderTabs,
    ),
    autosave('fuzzer', subscribeFuzzerWorkspace, setFuzzerWorkspace, undefined, resetTarget, mergeFuzzerWorkspace),
  ];
  return () => {
    stops.forEach((stop) => stop());
    resetTextDocumentCacheSettings();
  };
}

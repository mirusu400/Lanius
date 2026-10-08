/** Persistence shared by the workspace, project import and app shutdown. */
import { autosave } from './autosave';
import { getTabs, resetTabs, setTabs, subscribe as subscribeReplay } from './replayStore';
import { getDecoderTabs, resetDecoderTabs, setDecoderTabs, subscribe as subscribeDecoder } from './decoderStore';

export function startWorkspaceAutosaves(): () => void {
  const stops = [
    autosave('replay', (listener) => subscribeReplay(() => listener(getTabs())), setTabs, 'repeater', resetTabs),
    autosave(
      'decoder',
      (listener) => subscribeDecoder(() => listener(getDecoderTabs())),
      (value: ReturnType<typeof getDecoderTabs>) => value.length ? setDecoderTabs(value) : resetDecoderTabs(),
      'transform',
      resetDecoderTabs,
    ),
  ];
  return () => stops.forEach((stop) => stop());
}

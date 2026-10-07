/** Completion notifications for explicit Send to Replay/Fuzzer actions. */
export type RequestTransferTool = 'Replay' | 'Fuzzer';

type Listener = (tool: RequestTransferTool) => void;
const listeners = new Set<Listener>();

export function subscribeRequestTransfers(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifyRequestTransferred(tool: RequestTransferTool): void {
  for (const listener of listeners) listener(tool);
}

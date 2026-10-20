import { prepareTextDocument, type TextDocumentResult, type TextDocumentTask } from './textDocumentModel';

/** A cancelled viewer must stop CPU work as well as ignore stale results. */
export function runTextDocumentTask(task: TextDocumentTask, signal: AbortSignal): Promise<TextDocumentResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    let worker: Worker | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      worker?.terminate();
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    };
    const abort = () => { cleanup(); reject(new DOMException('Aborted', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    // Worker-less test/embedded environments still yield before preparing.
    if (typeof Worker === 'undefined') {
      timer = setTimeout(() => {
        try { const result = prepareTextDocument(task); cleanup(); resolve(result); }
        catch (error) { cleanup(); reject(error); }
      }, 0);
      return;
    }
    try {
      worker = new Worker(new URL('./textDocument.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<TextDocumentResult>) => { cleanup(); resolve(event.data); };
      worker.onerror = (event) => { cleanup(); reject(new Error(event.message || 'Text preparation failed')); };
      worker.postMessage(task);
    } catch (error) { cleanup(); reject(error); }
  });
}

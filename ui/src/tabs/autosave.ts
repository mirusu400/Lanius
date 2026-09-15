/** Autosave for the tab stores.
 *
 * Repeater and Decoder tabs lived only in the browser, so closing Lanius
 * threw away whatever you had open. They are written to the engine as you
 * work, debounced so typing does not mean a request per keystroke.
 */

import { getWorkspace, putWorkspace } from '../api/client';

const SAVE_DELAY_MS = 800;

/** Wire a store up to the workspace.
 *
 * Returns a disposer. Loading happens once; saving is debounced and skips
 * the load itself, so opening the app does not immediately write back
 * what it just read.
 */
export function autosave<T>(
  key: string,
  subscribe: (listener: (value: T) => void) => () => void,
  restore: (value: T) => void,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let loaded = false;
  let disposed = false;

  void getWorkspace<T>(key)
    .then(({ value }) => {
      if (disposed) return;
      if (value != null) restore(value);
    })
    .catch(() => undefined)
    .finally(() => {
      loaded = true;
    });

  // What was last written. Stores emit on every change, including ones
  // that leave the saved shape identical, and the payload can be hundreds
  // of kilobytes when a response body is large.
  let lastSent: string | undefined;

  const unsubscribe = subscribe((value) => {
    // Ignore the notification the subscription itself fires, and anything
    // before the saved state has been read, which would overwrite it.
    if (!loaded) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const encoded = JSON.stringify(value);
      if (encoded === lastSent) return;
      lastSent = encoded;
      void putWorkspace(key, value).catch(() => undefined);
    }, SAVE_DELAY_MS);
  });

  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    unsubscribe();
  };
}

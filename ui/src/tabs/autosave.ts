/** Autosave for the tab stores.
 *
 * Replay and Decoder tabs lived only in the browser, so closing Lanius
 * threw away whatever you had open. They are written to the engine as you
 * work, debounced so typing does not mean a request per keystroke.
 */

import { getWorkspace, putWorkspace } from '../api/client';

const SAVE_DELAY_MS = 800;
interface AutosaveControl {
  flush: () => Promise<void>;
  suspend: () => void;
  settle: () => Promise<void>;
  reload: () => Promise<void>;
  resume: () => void;
}
const controls = new Set<AutosaveControl>();
let workspaceReplacement: Promise<unknown> | null = null;

/** Finish pending writes before switching projects or closing the app. */
export async function flushAutosaves(): Promise<void> {
  // Closing during an import must save the imported tabs, never the old ones.
  await workspaceReplacement?.catch(() => undefined);
  await Promise.all([...controls].map((control) => control.flush()));
}

/** Drain old writes before replacing the DB, then restore the new tab state. */
export async function replaceWorkspace<T>(replace: () => Promise<T>): Promise<T> {
  if (workspaceReplacement) throw new Error('A workspace import is already in progress');
  const active = [...controls];
  active.forEach((control) => control.suspend());
  const operation = (async () => {
    try {
      await Promise.all(active.map((control) => control.settle()));
      const result = await replace();
      await Promise.all(active.map((control) => control.reload()));
      return result;
    } finally {
      active.forEach((control) => control.resume());
    }
  })();
  workspaceReplacement = operation;
  try {
    return await operation;
  } finally {
    workspaceReplacement = null;
  }
}

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
  legacyKey?: string,
  reset?: () => void,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let loaded = false;
  let disposed = false;
  let suspended = false;
  let latest: T | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  const load = async (resetMissing: boolean) => {
    loaded = false;
    let saved = await getWorkspace<T>(key);
    if (saved.value == null && legacyKey) saved = await getWorkspace<T>(legacyKey);
    if (disposed) return;
    if (saved.value != null) restore(saved.value);
    else if (resetMissing) reset?.();
    loaded = true;
  };
  const loadPromise = load(false).catch(() => { loaded = true; });

  // What was last written. Stores emit on every change, including ones
  // that leave the saved shape identical, and the payload can be hundreds
  // of kilobytes when a response body is large.
  let lastSent: string | undefined;

  const save = (value: T): Promise<void> => {
    const encoded = JSON.stringify(value);
    if (encoded === lastSent) return inFlight;
    lastSent = encoded;
    // Keep writes ordered; an earlier slow request must not overwrite the
    // final tab state when the user switches projects.
    inFlight = inFlight
      .catch(() => undefined)
      .then(() => putWorkspace(key, value).then(() => undefined))
      .catch((err: unknown) => {
        if (lastSent === encoded) lastSent = undefined;
        throw err;
      });
    return inFlight;
  };

  const flush = async () => {
    await loadPromise;
    // A failed refresh after a successful import must not write stale tabs.
    // Retry restoration before allowing a later close or project switch.
    if (!loaded) await reload();
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (latest !== undefined) await save(latest);
    else await inFlight;
  };

  const schedule = (value: T) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void save(value).catch(() => undefined);
    }, SAVE_DELAY_MS);
  };
  const reload = async () => {
    latest = undefined;
    lastSent = undefined;
    await load(true);
  };
  const control: AutosaveControl = {
    flush,
    suspend: () => {
      suspended = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    settle: async () => {
      await loadPromise;
      await inFlight.catch(() => undefined);
    },
    reload,
    resume: () => {
      suspended = false;
      if (loaded && latest !== undefined) schedule(latest);
    },
  };
  controls.add(control);

  const unsubscribe = subscribe((value) => {
    // Ignore the notification the subscription itself fires, and anything
    // before the saved state has been read, which would overwrite it.
    if (!loaded) return;
    latest = value;
    if (!suspended) schedule(value);
  });

  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    controls.delete(control);
    unsubscribe();
  };
}

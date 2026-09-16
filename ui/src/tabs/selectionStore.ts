/** What is selected in the Proxy history.
 *
 * Kept outside the component for the same reason the Repeater and
 * Decoder tabs are: React unmounts a tab when you switch away, so the
 * selection would be thrown away the moment you looked at anything else
 * and come back to nothing selected.
 */

type Listener = (id: string | null) => void;

let selectedId: string | null = null;
const listeners = new Set<Listener>();

export function getSelectedFlow(): string | null {
  return selectedId;
}

export function setSelectedFlow(id: string | null): void {
  if (id === selectedId) return;
  selectedId = id;
  for (const listener of listeners) listener(selectedId);
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  listener(selectedId);
  return () => {
    listeners.delete(listener);
  };
}

/** Forget the selection when the history is cleared.
 *
 * Deliberately not "drop it if the id is missing from this page": the
 * table shows one filtered page at a time, so a selected flow being
 * absent from it usually means it is filtered out or further down, not
 * that it is gone. Clearing is the one case where it really has gone.
 */
export function clearSelection(): void {
  setSelectedFlow(null);
}

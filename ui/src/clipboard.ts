/** Cross-platform text clipboard access.
 *
 * Desktop builds use Tauri's native plugin so behavior does not depend on
 * WebKitGTK, WebView2, secure-context detection, or transient browser
 * permissions. Browser development keeps the standard web API as a fallback.
 */

import {
  readText as readNativeText,
  writeText as writeNativeText,
} from '@tauri-apps/plugin-clipboard-manager';

const CLIPBOARD_ERROR = 'lanius:clipboard-error';

function isDesktop(): boolean {
  return (
    typeof window !== 'undefined'
    && '__TAURI_INTERNALS__' in (window as unknown as Record<string, unknown>)
  );
}

function clipboardError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export async function writeClipboardText(text: string): Promise<void> {
  try {
    if (isDesktop()) {
      await writeNativeText(text);
      return;
    }
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      throw new Error('Clipboard write is unavailable in this environment');
    }
    await navigator.clipboard.writeText(text);
  } catch (error) {
    throw clipboardError(error);
  }
}

export async function readClipboardText(): Promise<string> {
  try {
    if (isDesktop()) return await readNativeText();
    if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) {
      throw new Error('Clipboard read is unavailable in this environment');
    }
    return await navigator.clipboard.readText();
  } catch (error) {
    throw clipboardError(error);
  }
}

/** Report a clipboard failure through the app-wide toast path. */
export function notifyClipboardError(error: unknown): void {
  if (typeof window === 'undefined') return;
  const message = error instanceof Error ? error.message : String(error);
  window.dispatchEvent(new CustomEvent(CLIPBOARD_ERROR, { detail: message }));
}

/** Fire-and-forget copy for menu actions that do not own an error surface. */
export function copyTextToClipboard(text: string): void {
  void writeClipboardText(text).catch(notifyClipboardError);
}

export function subscribeClipboardErrors(listener: (message: string) => void): () => void {
  const handle = (event: Event) => listener((event as CustomEvent<string>).detail);
  window.addEventListener(CLIPBOARD_ERROR, handle);
  return () => window.removeEventListener(CLIPBOARD_ERROR, handle);
}

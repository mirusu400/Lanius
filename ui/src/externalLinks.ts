/**
 * Send links that leave the app to the system browser.
 *
 * The desktop webview ignores `target="_blank"`, so release notes, the
 * repository and plugin homepages did nothing when clicked. One listener
 * covers every such link instead of each component remembering to.
 */

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

function desktopInvoke(): Invoke | null {
  const internals = (window as unknown as {
    __TAURI_INTERNALS__?: { invoke: Invoke };
  }).__TAURI_INTERNALS__;
  return internals ? internals.invoke.bind(internals) : null;
}

/** The URL to hand to the system browser, or null to leave the click alone. */
export function externalUrl(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const anchor = target.closest('a[href]');
  if (!(anchor instanceof HTMLAnchorElement) || anchor.target !== '_blank') return null;
  // The app's own pages stay in the app; on Windows they are http too.
  if (!/^https?:$/.test(anchor.protocol) || anchor.origin === window.location.origin) return null;
  return anchor.href;
}

/** Install the listener; returns a function that removes it. */
export function installExternalLinks(root: Document = document): () => void {
  const listener = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0) return;
    const url = externalUrl(event.target);
    const invoke = url ? desktopInvoke() : null;
    if (!url || !invoke) return;
    event.preventDefault();
    invoke('open_external', { url }).catch((error: unknown) => {
      console.error('could not open link in the system browser', error);
    });
  };
  root.addEventListener('click', listener);
  return () => root.removeEventListener('click', listener);
}

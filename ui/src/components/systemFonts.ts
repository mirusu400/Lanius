/** The font families installed on this machine.
 *
 * The desktop shell reads them from the system, since neither WKWebView
 * nor WebKitGTK can list local fonts. In a browser, Chromium's Local Font
 * Access API is used when present. Otherwise the list is empty and the
 * pickers fall back to suggestions, with any name still typeable.
 */

export interface SystemFont {
  family: string;
  monospaced: boolean;
}

interface LocalFontData {
  family: string;
}

let cached: Promise<SystemFont[]> | null = null;

async function fromShell(): Promise<SystemFont[] | null> {
  const internals = (window as unknown as {
    __TAURI_INTERNALS__?: { invoke(cmd: string): Promise<unknown> };
  }).__TAURI_INTERNALS__;
  if (!internals) return null;
  const fonts = await internals.invoke('list_system_fonts');
  return Array.isArray(fonts) ? (fonts as SystemFont[]) : [];
}

async function fromBrowser(): Promise<SystemFont[]> {
  const query = (window as unknown as {
    queryLocalFonts?: () => Promise<LocalFontData[]>;
  }).queryLocalFonts;
  if (!query) return [];
  const families = new Map<string, string>();
  for (const font of await query()) {
    families.set(font.family.toLowerCase(), font.family);
  }
  // The browser does not say which are monospaced.
  return [...families.values()]
    .sort((a, b) => a.localeCompare(b))
    .map((family) => ({ family, monospaced: false }));
}

/** Listed once per session: scanning the fonts takes a moment. A failure
 *  is not cached, so opening the picker again retries. */
export function listSystemFonts(): Promise<SystemFont[]> {
  if (!cached) {
    cached = (async () => (await fromShell()) ?? (await fromBrowser()))();
    cached.catch(() => {
      cached = null;
    });
  }
  return cached;
}

/** Test helper. */
export function resetSystemFonts(): void {
  cached = null;
}

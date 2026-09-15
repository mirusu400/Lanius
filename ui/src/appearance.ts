/** Appearance: theme and typography.
 *
 * Kept outside React state because it applies to the document rather than
 * to any component, and has to be in place before the first paint so the
 * window does not flash the wrong theme on launch.
 */

export type ThemeChoice = 'system' | 'dark' | 'light';

export interface Appearance {
  theme: ThemeChoice;
  /** Interface font size in px. The rest of the layout follows it. */
  uiSize: number;
  /** Monospace size, used by the editors and the history table. */
  monoSize: number;
  /** Empty means the built-in stack. */
  monoFamily: string;
  uiFamily: string;
}

export const DEFAULTS: Appearance = {
  theme: 'system',
  uiSize: 13,
  monoSize: 12,
  monoFamily: '',
  uiFamily: '',
};

// Sizes a user can reach without the layout falling apart. Checked rather
// than trusted, since these also arrive from a saved project.
export const UI_SIZE_RANGE = { min: 10, max: 20 } as const;
export const MONO_SIZE_RANGE = { min: 9, max: 22 } as const;

/** The sizes offered in the dropdown. Any value in range can still be
 *  typed; these are the ones worth one click. */
export const UI_SIZE_PRESETS = [10, 11, 12, 13, 14, 15, 16, 18, 20] as const;
export const MONO_SIZE_PRESETS = [9, 10, 11, 12, 13, 14, 16, 18, 20, 22] as const;

/** Monospace stacks worth offering, with the default first. */
export const MONO_FAMILIES = [
  { id: '', stack: "'SF Mono', 'JetBrains Mono', Menlo, monospace" },
  { id: 'menlo', stack: 'Menlo, monospace' },
  { id: 'monaco', stack: 'Monaco, monospace' },
  { id: 'consolas', stack: 'Consolas, monospace' },
  { id: 'jetbrains', stack: "'JetBrains Mono', monospace" },
  { id: 'fira', stack: "'Fira Code', monospace" },
  { id: 'source', stack: "'Source Code Pro', monospace" },
  { id: 'ibm', stack: "'IBM Plex Mono', monospace" },
  { id: 'system', stack: 'ui-monospace, monospace' },
] as const;

export const UI_FAMILIES = [
  { id: '', stack: "-apple-system, 'Segoe UI', sans-serif" },
  { id: 'system', stack: 'system-ui, sans-serif' },
  { id: 'inter', stack: "Inter, -apple-system, sans-serif" },
  { id: 'helvetica', stack: "'Helvetica Neue', Helvetica, sans-serif" },
  { id: 'segoe', stack: "'Segoe UI', sans-serif" },
  { id: 'roboto', stack: 'Roboto, sans-serif' },
] as const;

const STORAGE_KEY = 'lanius.appearance';

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Accept a stored or imported value without trusting its shape. */
export function normalise(value: unknown): Appearance {
  const raw = (value ?? {}) as Partial<Appearance>;
  const theme: ThemeChoice =
    raw.theme === 'dark' || raw.theme === 'light' || raw.theme === 'system'
      ? raw.theme
      : DEFAULTS.theme;
  const known = (list: readonly { id: string }[], id: unknown) =>
    typeof id === 'string' && list.some((entry) => entry.id === id) ? id : '';
  return {
    theme,
    uiSize: clamp(
      Number(raw.uiSize),
      UI_SIZE_RANGE.min,
      UI_SIZE_RANGE.max,
      DEFAULTS.uiSize,
    ),
    monoSize: clamp(
      Number(raw.monoSize),
      MONO_SIZE_RANGE.min,
      MONO_SIZE_RANGE.max,
      DEFAULTS.monoSize,
    ),
    monoFamily: known(MONO_FAMILIES, raw.monoFamily),
    uiFamily: known(UI_FAMILIES, raw.uiFamily),
  };
}

export function load(): Appearance {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return normalise(stored ? JSON.parse(stored) : null);
  } catch {
    // Unreadable or unparseable storage must not stop the app starting.
    return { ...DEFAULTS };
  }
}

export function save(appearance: Appearance): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(appearance));
  } catch {
    // Private mode, or a full quota: the setting still applies for now.
  }
}

function prefersDark(): boolean {
  return (
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-color-scheme: dark)').matches
  );
}

/** Which palette 'system' resolves to right now. */
export function resolveTheme(choice: ThemeChoice): 'dark' | 'light' {
  if (choice === 'system') return prefersDark() ? 'dark' : 'light';
  return choice;
}

/** Put the choices onto the document, where the stylesheet reads them. */
export function apply(appearance: Appearance): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.theme = resolveTheme(appearance.theme);
  root.style.setProperty('--font-size-ui', `${appearance.uiSize}px`);
  root.style.setProperty('--font-size-mono', `${appearance.monoSize}px`);
  root.style.setProperty('--font-mono', stackOf(MONO_FAMILIES, appearance.monoFamily));
  root.style.setProperty('--font-ui', stackOf(UI_FAMILIES, appearance.uiFamily));
  applyWindowTheme(appearance.theme);
}

/** Match the window frame to the theme.
 *
 * The page repaints itself, but the title bar is drawn by the OS, so
 * without this the light theme left a dark bar above a light app.
 *
 * 'system' is passed through rather than resolved: the window then
 * follows the OS by itself, including changes made later.
 */
function applyWindowTheme(theme: ThemeChoice): void {
  const internals = (window as unknown as {
    __TAURI_INTERNALS__?: { invoke(cmd: string, args: unknown): Promise<unknown> };
  }).__TAURI_INTERNALS__;
  // Absent in a browser, where there is no window to set.
  if (!internals) return;
  void internals
    .invoke('set_window_theme', { theme: theme === 'system' ? null : theme })
    // A frame that does not match is worth less than a working app, so a
    // failure here is not worth interrupting anyone over.
    .catch(() => undefined);
}

/** Re-apply when the system theme changes, while following the system. */
export function watchSystem(onChange: () => void): () => void {
  if (typeof matchMedia !== 'function') return () => {};
  const query = matchMedia('(prefers-color-scheme: dark)');
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** Is a font family actually installed?
 *
 * The CSS stack falls back silently, so a user can pick a font and see
 * nothing change with no explanation. Measuring the width of the same
 * text in the candidate and in a known fallback tells them apart.
 */
export function fontAvailable(family: string): boolean {
  if (typeof document === 'undefined' || !family) return true;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return true;

  const sample = 'mmmmmmmmmmlli0O';
  const measure = (stack: string): number => {
    context.font = `72px ${stack}`;
    return context.measureText(sample).width;
  };

  // monospace is the reference: if asking for the candidate first gives a
  // different width, the candidate was used, so it exists.
  const fallback = measure('monospace');
  const candidate = measure(`${family}, monospace`);
  if (candidate !== fallback) return true;

  // A monospace font can legitimately match; check against a second base.
  const serif = measure('serif');
  return measure(`${family}, serif`) !== serif;
}

/** The first named family in a stack, which is the one worth checking. */
export function primaryFamily(stack: string): string {
  const first = stack.split(',')[0]?.trim() ?? '';
  return first.replace(/^['"]|['"]$/g, '');
}

export function stackOf(
  list: readonly { id: string; stack: string }[],
  id: string,
): string {
  return (list.find((entry) => entry.id === id) ?? list[0]).stack;
}

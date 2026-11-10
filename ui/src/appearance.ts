/** Appearance: theme and typography.
 *
 * Kept outside React state because it applies to the document rather than
 * to any component, and has to be in place before the first paint so the
 * window does not flash the wrong theme on launch.
 */

export type ThemePalette =
  | 'dark' | 'light' | 'copper' | 'steel' | 'sage' | 'paper'
  | 'monokai' | 'gruvbox' | 'dracula' | 'tokyo-night' | 'catppuccin' | 'solarized';
export type ThemeChoice = 'system' | ThemePalette;

const THEME_CHOICES: readonly ThemeChoice[] = [
  'system', 'dark', 'light', 'copper', 'steel', 'sage', 'paper',
  'monokai', 'gruvbox', 'dracula', 'tokyo-night', 'catppuccin', 'solarized',
];

export interface Appearance {
  theme: ThemeChoice;
  /** Interface font size in px. The rest of the layout follows it. */
  uiSize: number;
  /** Monospace size, used by the editors and the history table. */
  monoSize: number;
  /** A font family name. Empty means the built-in stack. */
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

/** What each font falls back to, and what an empty choice means. */
export const DEFAULT_MONO_STACK = "'SF Mono', 'JetBrains Mono', Menlo, monospace";
export const DEFAULT_UI_STACK = "-apple-system, 'Segoe UI', sans-serif";

/** Offered when the installed fonts cannot be listed, as in a browser
 *  without the Local Font Access API. */
export const SUGGESTED_MONO_FAMILIES = [
  'Menlo', 'Monaco', 'Consolas', 'JetBrains Mono', 'Fira Code',
  'Source Code Pro', 'IBM Plex Mono', 'ui-monospace',
] as const;
export const SUGGESTED_UI_FAMILIES = [
  'system-ui', 'Inter', 'Helvetica Neue', 'Segoe UI', 'Roboto',
] as const;

/** Choices saved before any installed font could be picked were ids
 *  from a fixed list. Read them as the families they stood for. */
const LEGACY_MONO_IDS: Record<string, string> = {
  menlo: 'Menlo',
  monaco: 'Monaco',
  consolas: 'Consolas',
  jetbrains: 'JetBrains Mono',
  fira: 'Fira Code',
  source: 'Source Code Pro',
  ibm: 'IBM Plex Mono',
  system: 'ui-monospace',
};
const LEGACY_UI_IDS: Record<string, string> = {
  system: 'system-ui',
  inter: 'Inter',
  helvetica: 'Helvetica Neue',
  segoe: 'Segoe UI',
  roboto: 'Roboto',
};

/** CSS generic families, which only work unquoted. */
const GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji',
]);

const MAX_FAMILY_LENGTH = 120;

/** A family name that is safe to write into a CSS custom property.
 *
 * The value is quoted when used, so quotes, backslashes and anything
 * that could end the declaration are dropped rather than escaped. No
 * real font needs them, and these values also arrive from imports.
 */
export function cleanFamily(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    // oxlint-disable-next-line no-control-regex -- Control characters are what is being removed.
    .replace(/[\u0000-\u001f\u007f"'\\;{}<>,]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_FAMILY_LENGTH)
    .trim();
}

function normaliseFamily(value: unknown, legacy: Record<string, string>): string {
  if (typeof value === 'string' && Object.hasOwn(legacy, value)) return legacy[value];
  return cleanFamily(value);
}

/** The CSS stack for a chosen family, falling back to the default. */
export function fontStack(family: string, fallback: string): string {
  const clean = cleanFamily(family);
  if (!clean) return fallback;
  const name = GENERIC_FAMILIES.has(clean.toLowerCase()) ? clean : `"${clean}"`;
  return `${name}, ${fallback}`;
}

const STORAGE_KEY = 'lanius.appearance';

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Accept a stored or imported value without trusting its shape. */
export function normalise(value: unknown): Appearance {
  const raw = (value ?? {}) as Partial<Appearance>;
  const theme: ThemeChoice =
    THEME_CHOICES.find((choice) => choice === raw.theme) ?? DEFAULTS.theme;
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
    monoFamily: normaliseFamily(raw.monoFamily, LEGACY_MONO_IDS),
    uiFamily: normaliseFamily(raw.uiFamily, LEGACY_UI_IDS),
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

export function save(appearance: Appearance): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(appearance));
    return true;
  } catch {
    // Private mode, or a full quota: the setting still applies for now.
    return false;
  }
}

function prefersDark(): boolean {
  return (
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-color-scheme: dark)').matches
  );
}

/** System dark uses Steel; the older orange dark remains a separate choice. */
export function resolveTheme(choice: ThemeChoice): ThemePalette {
  if (choice === 'system') return prefersDark() ? 'steel' : 'light';
  return choice;
}

/** Put the choices onto the document, where the stylesheet reads them. */
export function apply(appearance: Appearance): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.theme = resolveTheme(appearance.theme);
  root.style.setProperty('--font-size-ui', `${appearance.uiSize}px`);
  root.style.setProperty('--font-size-mono', `${appearance.monoSize}px`);
  root.style.setProperty('--font-mono', fontStack(appearance.monoFamily, DEFAULT_MONO_STACK));
  root.style.setProperty('--font-ui', fontStack(appearance.uiFamily, DEFAULT_UI_STACK));
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
  const windowTheme = theme === 'system' ? null :
    theme === 'light' || theme === 'paper' ? 'light' : 'dark';
  void internals
    .invoke('set_window_theme', { theme: windowTheme })
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

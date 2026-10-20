/** Notification choices belong to this device, independently of projects. */
export const TOAST_PREFERENCES_KEY = 'lanius.toasts.v1';

export const TOAST_CATEGORIES = [
  'replay', 'fuzzerTransfer', 'settings', 'search', 'fuzzerRun',
  'project', 'cleanup', 'browser', 'plugins', 'history', 'scope', 'scanner', 'screenshot',
] as const;
export type ToastCategory = typeof TOAST_CATEGORIES[number];
export type ToastPreferences = Record<ToastCategory, boolean>;

export function defaultToastPreferences(): ToastPreferences {
  return Object.fromEntries(TOAST_CATEGORIES.map((key) => [key, true])) as ToastPreferences;
}

export function loadToastPreferences(): ToastPreferences {
  const defaults = defaultToastPreferences();
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(TOAST_PREFERENCES_KEY) ?? 'null');
    if (!stored || typeof stored !== 'object') return defaults;
    for (const key of TOAST_CATEGORIES) {
      const value = (stored as Record<string, unknown>)[key];
      if (typeof value === 'boolean') defaults[key] = value;
    }
  } catch { /* An unreadable preference must not hide notifications. */ }
  return defaults;
}

export function saveToastPreferences(value: ToastPreferences): boolean {
  try {
    localStorage.setItem(TOAST_PREFERENCES_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

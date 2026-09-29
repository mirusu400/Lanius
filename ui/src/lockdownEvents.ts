/** Shared notification path for blocked product-owned network operations. */
export const LOCKDOWN_BLOCKED = 'lanius:lockdown-blocked';
export const LOCKDOWN_CHANGED = 'lanius:lockdown-changed';

export function notifyLockdownBlocked(): void {
  window.dispatchEvent(new Event(LOCKDOWN_BLOCKED));
}

export function notifyLockdownChanged(): void {
  window.dispatchEvent(new Event(LOCKDOWN_CHANGED));
}

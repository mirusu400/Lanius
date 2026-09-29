/** Whether a newer build has been published.
 *
 * Kept outside React because two places care: the Settings screen, which
 * shows the detail and owns the button, and the title bar, which shows a
 * badge no matter which tab you are on. One check answers both.
 *
 * The check is a question, not an installer. It asks GitHub what the
 * newest build is and says so; downloading stays a decision the user
 * makes, which matters for a tool that is often run somewhere with no
 * outbound access at all. That is also why it can be turned off.
 */

import { useEffect, useState } from 'react';

import {
  checkUpdates,
  type UpdateChannel,
  type UpdateCheck,
} from './api/client';

const CHANNEL_KEY = 'lanius.updates.channel';
const AUTO_KEY = 'lanius.updates.auto';
const CHECKED_KEY = 'lanius.updates.checkedAt';

/** How long an automatic check waits before asking again. Long enough
 *  that opening the app five times in an hour asks once. */
export const AUTO_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface UpdateState {
  result: UpdateCheck | null;
  error: string | null;
  busy: boolean;
}

let state: UpdateState = { result: null, error: null, busy: false };
const listeners = new Set<(value: UpdateState) => void>();

function set(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener(state);
}

export function getUpdateState(): UpdateState {
  return state;
}

export function subscribe(listener: (value: UpdateState) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function read(key: string): string | null {
  try {
    return window.localStorage?.getItem(key) ?? null;
  } catch {
    // Private mode, or storage the browser refuses: the defaults hold.
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage?.removeItem(key);
    else window.localStorage?.setItem(key, value);
  } catch {
    // The setting applies for this session even if it cannot be saved.
  }
}

/** Which stream to compare against, or null to follow the build itself:
 *  a nightly is compared with the nightlies, a tagged build with the
 *  releases. */
export function channelPreference(): UpdateChannel | null {
  const stored = read(CHANNEL_KEY);
  return stored === 'stable' || stored === 'nightly' ? stored : null;
}

export function setChannelPreference(channel: UpdateChannel | null): void {
  write(CHANNEL_KEY, channel);
}

/** Automatic checks are on unless turned off. */
export function autoCheckEnabled(): boolean {
  return read(AUTO_KEY) !== 'off';
}

export function setAutoCheckEnabled(enabled: boolean): void {
  write(AUTO_KEY, enabled ? 'on' : 'off');
}

/** When the last check actually reached GitHub, as epoch milliseconds. */
export function lastCheckedAt(): number | null {
  const stored = Number(read(CHECKED_KEY));
  return Number.isFinite(stored) && stored > 0 ? stored : null;
}

/** Ask now, and tell everyone watching.
 *
 * `refresh` skips the engine's cache, which is what a button press
 * means: the user is asking because something may have changed.
 */
export async function runCheck(
  options: { refresh?: boolean } = {},
): Promise<UpdateState> {
  set({ busy: true, error: null });
  try {
    const result = await checkUpdates({
      channel: channelPreference() ?? undefined,
      refresh: options.refresh,
    });
    write(CHECKED_KEY, String(Date.now()));
    set({ result, error: null, busy: false });
  } catch (err) {
    // Offline is the usual reason, and it is not a failure of the app.
    set({ error: String(err instanceof Error ? err.message : err), busy: false });
  }
  return state;
}

/** The check on startup: quiet, optional, and not on every launch. */
export async function autoCheck(): Promise<void> {
  if (!autoCheckEnabled()) return;
  const last = lastCheckedAt();
  if (last !== null && Date.now() - last < AUTO_INTERVAL_MS) return;
  await runCheck();
}

/** Forget the last answer. For tests, and for nothing else. */
export function resetUpdates(): void {
  set({ result: null, error: null, busy: false });
}

/** Subscribe a component to the answer. */
export function useUpdates(): UpdateState {
  const [value, setValue] = useState<UpdateState>(getUpdateState);
  useEffect(() => subscribe(setValue), []);
  return value;
}

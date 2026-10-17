/** A loading indicator that only appears when the wait is real.
 *
 * Most tab switches settle in well under a tenth of a second. Showing a
 * spinner for those makes the app feel worse, not better: a flash of
 * something appearing and vanishing reads as a glitch. So nothing is
 * drawn until the wait has gone on long enough to be noticed, and once
 * drawn it stays briefly, because a spinner that blinks out immediately
 * is the same flicker in reverse.
 */

import { useEffect, useState } from 'react';

import { useT } from '../i18n';

/** Long enough that a quick load stays invisible. */
export const SHOW_AFTER_MS = 200;
/** Once shown, stay up at least this long. */
export const MIN_VISIBLE_MS = 400;

/** Whether to show a busy indicator for a load that may be quick. */
export function useDelayedBusy(
  busy: boolean,
  showAfter = SHOW_AFTER_MS,
  minVisible = MIN_VISIBLE_MS,
): boolean {
  const [visible, setVisible] = useState(false);
  const [shownAt, setShownAt] = useState<number | null>(null);

  useEffect(() => {
    if (busy) {
      if (visible) return;
      const timer = window.setTimeout(() => {
        setShownAt(Date.now());
        setVisible(true);
      }, showAfter);
      return () => window.clearTimeout(timer);
    }

    if (!visible) return;
    const elapsed = shownAt ? Date.now() - shownAt : minVisible;
    const remaining = Math.max(0, minVisible - elapsed);
    const timer = window.setTimeout(() => {
      setVisible(false);
      setShownAt(null);
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [busy, visible, shownAt, showAfter, minVisible]);

  return visible;
}

/** Circumference of the r=13 circle the arc is drawn on. */
const ARC_LENGTH = 2 * Math.PI * 13;

/** The circle itself. With a value (0-100) it fills instead of turning. */
export function Spinner({ label, value }: { label?: string; value?: number }) {
  const t = useT();
  const text = label ?? t('common.loading');
  const determinate = value !== undefined;
  const filled = determinate ? ARC_LENGTH * Math.min(100, Math.max(0, value)) / 100 : 0;
  return (
    <span
      className={determinate ? 'spinner determinate' : 'spinner'}
      role={determinate ? 'progressbar' : 'status'}
      aria-label={text}
      aria-valuemin={determinate ? 0 : undefined}
      aria-valuemax={determinate ? 100 : undefined}
      aria-valuenow={determinate ? Math.round(value) : undefined}
    >
      <svg viewBox="0 0 32 32" aria-hidden="true">
        {/* The track makes the moving arc legible on any background. */}
        <circle className="spinner-track" cx="16" cy="16" r="13" />
        <circle
          className="spinner-arc"
          cx="16"
          cy="16"
          r="13"
          style={determinate ? { strokeDasharray: `${filled} ${ARC_LENGTH}` } : undefined}
        />
      </svg>
    </span>
  );
}

/** A centred spinner for a pane that has nothing to show yet. */
export function LoadingPane({ label }: { label?: string }) {
  return (
    <div className="loading-pane">
      <Spinner label={label} />
    </div>
  );
}

/**
 * Shows its children, with a spinner over them while loading.
 *
 * Kept as an overlay rather than a replacement so that switching back to
 * a tab you have already loaded does not blank out the content you were
 * looking at.
 */
export function Busy({
  busy,
  children,
  label,
}: {
  busy: boolean;
  children: React.ReactNode;
  label?: string;
}) {
  const visible = useDelayedBusy(busy);
  return (
    <div className="busy-host">
      {children}
      {visible && (
        <div className="busy-overlay">
          <Spinner label={label} />
        </div>
      )}
    </div>
  );
}

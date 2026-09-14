/** Pure helpers for the dashboard, kept out of the component so the
 * formatting rules can be tested directly. */

export const STATUS_ORDER = ['2xx', '3xx', '4xx', '5xx'] as const;

/** Human-readable byte count. Uses 1024 steps, as traffic tools do. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // Whole bytes read oddly as "1.0 B", so only scaled values get a decimal.
  const digits = unit === 0 ? 0 : value < 10 ? 1 : 0;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/** A response time. Sub-millisecond values would round to a bare "0 ms". */
export function formatMillis(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '-';
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms >= 1) return `${Math.round(ms)} ms`;
  return '<1 ms';
}

/** A span of seconds as a coarse duration, e.g. "3m 20s". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Shorten mitmproxy's bind errors for display.
 *
 * They restate the errno and repeat the address, e.g. "[Errno 48] reverse
 * proxy to X failed to listen on H:P with [Errno 48] error while attempting
 * to bind on address ('H', P): address already in use", which wraps to two
 * lines in a banner. The cause is the only part a reader needs.
 */
export function shortenModeError(error: string): string {
  const cause = error.match(/:\s*([^:]+)$/);
  const detail = (cause ? cause[1] : error).trim();
  if (!detail || detail.length >= error.length) return error;
  const port = error.match(/\b(\d{2,5})\)?:/);
  return port ? `${detail} (port ${port[1]})` : detail;
}

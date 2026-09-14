import { describe, expect, it } from 'vitest';

import {
  formatBytes,
  formatDuration,
  formatMillis,
  shortenModeError,
} from './dashboardModel';

describe('formatBytes', () => {
  it('leaves whole bytes without a decimal', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
  });

  it('scales to binary units', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB');
  });

  it('drops the decimal once the number is large enough to read', () => {
    expect(formatBytes(1024 * 45)).toBe('45 KB');
  });

  it('treats missing or negative totals as zero', () => {
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });
});

describe('formatMillis', () => {
  it('shows a dash when there is no timing', () => {
    expect(formatMillis(null)).toBe('-');
  });

  it('rounds milliseconds', () => {
    expect(formatMillis(12.4)).toBe('12 ms');
  });

  it('switches to seconds past a second', () => {
    expect(formatMillis(1500)).toBe('1.50 s');
  });

  it('does not report a sub-millisecond response as 0 ms', () => {
    expect(formatMillis(0.3)).toBe('<1 ms');
  });
});

describe('formatDuration', () => {
  it('reports seconds', () => {
    expect(formatDuration(45)).toBe('45s');
  });

  it('reports minutes and seconds', () => {
    expect(formatDuration(200)).toBe('3m 20s');
  });

  it('collapses to hours and minutes when long', () => {
    expect(formatDuration(3600 * 2 + 60 * 30)).toBe('2h 30m');
  });

  it('handles an empty capture', () => {
    expect(formatDuration(0)).toBe('0s');
  });
});

describe('shortenModeError', () => {
  it('keeps only the cause of a bind failure', () => {
    const raw =
      "[Errno 48] reverse proxy to http://example.com failed to listen on " +
      "127.0.0.1:9399 with [Errno 48] error while attempting to bind on " +
      "address ('127.0.0.1', 9399): address already in use";
    expect(shortenModeError(raw)).toBe('address already in use (port 9399)');
  });

  it('leaves a message that is already short alone', () => {
    expect(shortenModeError('boom')).toBe('boom');
  });

  it('does not mangle a message with no trailing cause', () => {
    const raw = 'something went wrong';
    expect(shortenModeError(raw)).toBe(raw);
  });
});

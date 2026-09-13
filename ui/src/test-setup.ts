/** Global test setup.
 *
 * Components open a WebSocket to the engine on mount. Without a stub the real
 * undici client tries to reach 127.0.0.1:8081, which makes the suite depend on
 * a running engine and throws after tests finish. Individual tests may still
 * install their own richer mock.
 */

import { beforeEach, vi } from 'vitest';

class InertSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState = InertSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
  }

  send(): void {}

  close(): void {
    this.readyState = InertSocket.CLOSED;
  }

  addEventListener(): void {}
  removeEventListener(): void {}
}

beforeEach(() => {
  // Only stub when a test has not provided its own WebSocket double.
  if (!('__laniusSocketMock' in globalThis)) {
    vi.stubGlobal('WebSocket', InertSocket as unknown as typeof WebSocket);
  }
});

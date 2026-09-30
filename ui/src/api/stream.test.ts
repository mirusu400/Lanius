import { afterEach, expect, it, vi } from 'vitest';

import { setApiToken } from './client';
import { connectStream } from './stream';

const created: Array<{ url: string; protocols?: string | string[] }> = [];

class FakeSocket {
  onopen: WebSocket['onopen'] = null;
  onmessage: WebSocket['onmessage'] = null;
  onclose: WebSocket['onclose'] = null;
  onerror: WebSocket['onerror'] = null;

  constructor(url: string, protocols?: string | string[]) {
    created.push({ url, protocols });
  }

  close() {}
}

afterEach(() => {
  created.length = 0;
  setApiToken('');
  vi.unstubAllGlobals();
});

it('sends the desktop session token as a WebSocket subprotocol', () => {
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
  setApiToken('desktop-secret');

  const disconnect = connectStream({ onEvent: () => {} });

  expect(created[0]?.protocols).toEqual([
    'lanius',
    'lanius-auth-desktop-secret',
  ]);
  disconnect();
});

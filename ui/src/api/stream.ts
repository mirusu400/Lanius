/** WebSocket client with auto-reconnect for the live flow stream. */

import type { EngineEvent } from './types';
import { API_BASE } from './client';

export const WS_URL = `${API_BASE.replace(/^http/, 'ws')}/ws`;

export type ConnectionState = 'connecting' | 'open' | 'closed';

export interface StreamHandlers {
  onEvent: (event: EngineEvent) => void;
  onState?: (state: ConnectionState) => void;
}

/** Opens the stream and returns a disposer. Reconnects with backoff. */
export function connectStream(handlers: StreamHandlers): () => void {
  let socket: WebSocket | null = null;
  let timer: number | undefined;
  let attempt = 0;
  let disposed = false;

  const open = () => {
    if (disposed) return;
    handlers.onState?.('connecting');
    socket = new WebSocket(WS_URL);

    socket.onopen = () => {
      attempt = 0;
      handlers.onState?.('open');
    };

    socket.onmessage = (message) => {
      try {
        handlers.onEvent(JSON.parse(message.data as string) as EngineEvent);
      } catch {
        // ignore malformed frames
      }
    };

    socket.onclose = () => {
      handlers.onState?.('closed');
      if (disposed) return;
      const delay = Math.min(1000 * 2 ** attempt, 10_000);
      attempt += 1;
      timer = window.setTimeout(open, delay);
    };

    socket.onerror = () => socket?.close();
  };

  open();

  return () => {
    disposed = true;
    if (timer) window.clearTimeout(timer);
    socket?.close();
  };
}

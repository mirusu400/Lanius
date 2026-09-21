import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { renderWithI18n as render, t } from '../test-utils';
import { WebSocketPanel } from './WebSocketPanel';

let repeated: Record<string, unknown> | null = null;

beforeEach(() => {
  repeated = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/websockets/repeat')) {
        repeated = JSON.parse(String(init?.body));
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          rules: { enabled: false, client_messages: true, server_messages: true },
          connections: [{ id: 'c1', host: 'example.com', path: '/socket', url: 'wss://example.com/socket', active: true, started_at: 1 }],
          messages: [{ id: 'm1', connection_id: 'c1', host: 'example.com', path: '/socket', from_client: true, is_text: true, timestamp: 1, size: 5, content: 'hello', encoding: 'utf-8', injected: false, dropped: false, paused: false }],
          paused: [],
        }),
      } as Response;
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('loads captured messages and repeats the edited payload', async () => {
  const user = userEvent.setup();
  render(<WebSocketPanel />);
  await user.click(await screen.findByText('example.com/socket'));
  const editor = screen.getByRole('textbox') as HTMLTextAreaElement;
  await user.clear(editor);
  await user.type(editor, 'changed');
  await user.click(screen.getByRole('button', { name: t('websocket.repeat') }));
  await waitFor(() => expect(repeated).not.toBeNull());
  expect(repeated?.content).toBe('changed');
  expect(repeated?.to_client).toBe(false);
});

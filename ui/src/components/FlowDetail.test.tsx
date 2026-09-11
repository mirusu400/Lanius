/** Detail pane: HTTP vs raw TCP rendering. */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FlowDetailView, toHex } from './FlowDetail';
import type { FlowSummary } from '../api/types';

const httpFlow: FlowSummary = {
  id: 'h1',
  type: 'http',
  client_addr: null,
  server_addr: null,
  scheme: 'https',
  method: 'GET',
  host: 'api.test',
  port: 443,
  path: '/x',
  query: null,
  http_version: 'HTTP/1.1',
  request_size: 0,
  started_at: 1,
  status_code: 200,
  reason: 'OK',
  response_size: 2,
  response_mime: null,
  completed_at: null,
  duration_ms: null,
  error: null,
  source: 'proxy',
  comment: null,
};

const tcpFlow: FlowSummary = {
  ...httpFlow,
  id: 't1',
  type: 'tcp',
  scheme: 'tcp',
  method: 'TCP',
  port: 19100,
  path: 'tcp://api.test:19100',
  status_code: null,
  comment: '3 messages',
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const isTcp = String(input).includes('t1');
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          ...(isTcp ? tcpFlow : httpFlow),
          request_headers: isTcp ? [] : [['Host', 'api.test']],
          request_body: isTcp ? 'HELLO\r\n' : '',
          response_headers: isTcp ? null : [['Content-Type', 'text/plain']],
          response_body: isTcp ? '220 READY\r\n' : 'ok',
        }),
      } as Response;
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('toHex', () => {
  it('produces offset, hex and ascii columns', () => {
    expect(toHex('AB')).toBe('00000000  41 42' + ' '.repeat(42) + '  |AB|');
  });

  it('replaces unprintable bytes with dots', () => {
    expect(toHex('\r\n')).toContain('|..|');
  });

  it('wraps at 16 bytes', () => {
    expect(toHex('x'.repeat(20)).split('\n')).toHaveLength(2);
  });

  it('handles empty input', () => {
    expect(toHex('')).toBe('(비어 있음)');
  });
});

describe('FlowDetailView', () => {
  it('shows headers for HTTP flows', async () => {
    render(<FlowDetailView flow={httpFlow} />);
    expect(await screen.findByText('Headers')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Response \(200\)/ })).toBeTruthy();
  });

  it('shows a byte and hex view for TCP flows', async () => {
    render(<FlowDetailView flow={tcpFlow} />);
    expect(await screen.findByText(/Raw bytes · 3 messages/)).toBeTruthy();
    expect(screen.getByText('Hex')).toBeTruthy();
    expect(screen.queryByText('Headers')).toBeNull();
    await waitFor(() =>
      expect(document.body.textContent).toContain('48 45 4c 4c 4f'),
    );
  });

  it('labels TCP directions instead of request/response', async () => {
    render(<FlowDetailView flow={tcpFlow} />);
    expect(await screen.findByRole('button', { name: '→ Server' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '← Client' })).toBeTruthy();
  });

  it('prompts when nothing is selected', () => {
    render(<FlowDetailView flow={null} />);
    expect(screen.getByText(/flow를 선택하면/)).toBeTruthy();
  });
});

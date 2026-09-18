/** Detail pane: HTTP vs raw TCP rendering. */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithI18n as render, t } from '../test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FlowDetailView } from './FlowDetail';
import { toHex } from './bodyFormat';
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

/** A flow whose response body is JSON on one line. */
const jsonFlow: FlowSummary = { ...httpFlow, id: 'j1' };

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
      const isJson = String(input).includes('j1');
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          ...(isTcp ? tcpFlow : httpFlow),
          request_headers: isTcp ? [] : [['Host', 'api.test']],
          request_body: isTcp ? 'HELLO\r\n' : '',
          response_headers: isTcp ? null : [['Content-Type', 'text/plain']],
          response_body: isTcp
            ? '220 READY\r\n'
            : isJson
              ? '{"a":1,"b":2}'
              : 'ok',
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

  it('returns an empty string for empty input (the caller localises it)', () => {
    expect(toHex('')).toBe('');
  });
});

describe('FlowDetailView', () => {
  it('shows request and response together, not one at a time', async () => {
    // Comparing what was sent with what came back is the usual reason to open a flow.
    render(<FlowDetailView flow={httpFlow} />);
    expect(await screen.findByText(t('detail.request'))).toBeTruthy();
    expect(screen.getByText(`${t('detail.response')} (200)`)).toBeTruthy();
  });

  it('parses headers for HTTP flows', async () => {
    render(<FlowDetailView flow={httpFlow} />);
    await waitFor(() => expect(screen.getAllByText(t('detail.headers')).length).toBe(2));
    expect(screen.getByText('Host')).toBeTruthy();
    expect(screen.getByText('Content-Type')).toBeTruthy();
  });

  it('offers a raw view that reads as HTTP', async () => {
    render(<FlowDetailView flow={httpFlow} />);
    const tabs = await screen.findAllByRole('tab', { name: t('detail.view.raw') });
    await userEvent.click(tabs[0]);
    const raw = screen.getAllByRole('textbox')[0] as HTMLTextAreaElement;
    expect(raw.value).toContain('GET /x HTTP/1.1');
    expect(raw.value).toContain('Host: api.test');
  });

  it('the raw response carries the status line', async () => {
    render(<FlowDetailView flow={httpFlow} />);
    const tabs = await screen.findAllByRole('tab', { name: t('detail.view.raw') });
    await userEvent.click(tabs[1]);
    const raw = screen.getAllByRole('textbox')[0] as HTMLTextAreaElement;
    expect(raw.value).toContain('HTTP/1.1 200 OK');
    expect(raw.value).toContain('ok');
  });

  it('offers a hex view of the same bytes', async () => {
    render(<FlowDetailView flow={httpFlow} />);
    const tabs = await screen.findAllByRole('tab', { name: t('detail.view.hex') });
    await userEvent.click(tabs[0]);
    // "GET" in hex.
    await waitFor(() => expect(document.body.textContent).toContain('47 45 54'));
  });

  it('does not offer to parse a raw TCP stream', async () => {
    // It has no headers, so parsing would only produce an empty table.
    render(<FlowDetailView flow={tcpFlow} />);
    await waitFor(() =>
      expect(screen.queryAllByRole('tab', { name: t('detail.view.parsed') })).toHaveLength(0),
    );
    expect(screen.getAllByRole('tab', { name: t('detail.view.hex') }).length).toBe(2);
  });

  it('labels TCP directions instead of request and response', async () => {
    render(<FlowDetailView flow={tcpFlow} />);
    expect(await screen.findByText(t('detail.toServer'))).toBeTruthy();
    expect(screen.getByText(t('detail.toClient'))).toBeTruthy();
  });

  it('keeps the TCP message count, which says it is several exchanges', async () => {
    render(<FlowDetailView flow={tcpFlow} />);
    expect(await screen.findByText('3 messages')).toBeTruthy();
  });

  it('has no send buttons: those moved to the right-click menu', async () => {
    render(<FlowDetailView flow={httpFlow} />);
    await screen.findByText(t('detail.request'));
    expect(screen.queryByRole('button', { name: t('menu.sendToRepeater') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('menu.sendToIntruder') })).toBeNull();
  });

  it('offers them on right-click instead', async () => {
    render(<FlowDetailView flow={httpFlow} />);
    const half = (await screen.findByText(t('detail.request'))).closest('section')!;
    fireEvent.contextMenu(half);
    expect(screen.getByRole('menuitem', { name: t('menu.sendToRepeater') })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: t('menu.sendToIntruder') })).toBeTruthy();
  });

  it('keeps the reveal toggle reachable next to a long URL', async () => {
    // The URL has to be the element that shrinks. When it was not, the
    // toggle was laid out past the right edge of the pane and could not
    // be clicked at all.
    render(<FlowDetailView flow={httpFlow} />);
    await screen.findByText(t('detail.request'));
    const toggle = document.querySelector('.detail-url .reveal');
    const url = document.querySelector('.detail-url-text');
    expect(toggle).toBeTruthy();
    expect(url).toBeTruthy();
    // The URL is inside its own shrinkable box rather than a direct
    // child competing with the toggle for space.
    expect(url!.contains(toggle!)).toBe(false);
  });

  it('can reveal the headers it masks by default', async () => {
    render(<FlowDetailView flow={httpFlow} />);
    await screen.findByText(t('detail.request'));
    const toggle = screen.getByRole('checkbox');
    await userEvent.click(toggle);
    expect((toggle as HTMLInputElement).checked).toBe(true);
  });

  it('lays out a JSON body, which arrives as one line', async () => {
    // Captured JSON is unreadable as it comes off the wire.
    render(<FlowDetailView flow={jsonFlow} />);
    const body = await screen.findByText(/"a": 1/);
    expect(body).toBeTruthy();
  });

  it('offers the exact bytes when the body has been laid out', async () => {
    render(<FlowDetailView flow={jsonFlow} />);
    const toggle = await screen.findByRole('button', { name: t('body.showRaw') });
    await userEvent.click(toggle);
    expect(await screen.findByText('{"a":1,"b":2}')).toBeTruthy();
  });

  it('goes back to the laid-out view', async () => {
    render(<FlowDetailView flow={jsonFlow} />);
    await userEvent.click(
      await screen.findByRole('button', { name: t('body.showRaw') }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: t('body.showPretty') }),
    );
    expect(await screen.findByText(/"a": 1/)).toBeTruthy();
  });

  it('does not offer the choice for a body it cannot lay out', async () => {
    // A control that does nothing is worse than no control.
    render(<FlowDetailView flow={httpFlow} />);
    await screen.findByText(t('detail.request'));
    expect(screen.queryByRole('button', { name: t('body.showRaw') })).toBeNull();
  });

  it('prompts when nothing is selected', () => {
    render(<FlowDetailView flow={null} />);
    expect(screen.getByText(t('detail.selectPrompt'))).toBeTruthy();
  });
});

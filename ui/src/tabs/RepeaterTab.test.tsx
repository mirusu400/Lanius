/** Renders the real Repeater tab against a mocked engine. */
import {cleanup, screen, waitFor } from '@testing-library/react';
import { renderWithI18n as render, t } from '../test-utils';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RepeaterTabView } from './RepeaterTab';
import { resetTabs, sendToRepeater, getTabs } from './repeaterStore';
import type { FlowSummary } from '../api/types';

const flow: FlowSummary = {
  id: 'f1',
  type: 'http',
  client_addr: null,
  server_addr: null,
  scheme: 'http',
  method: 'GET',
  host: 'echo.test',
  port: 80,
  path: '/hello',
  query: null,
  http_version: 'HTTP/1.1',
  request_size: 0,
  started_at: 1,
  status_code: 200,
  reason: 'OK',
  response_size: 0,
  response_mime: null,
  completed_at: null,
  duration_ms: null,
  error: null,
  source: 'proxy',
  comment: null,
};

let sent: unknown[] = [];

beforeEach(() => {
  resetTabs();
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          id: 'r1',
          status_code: 201,
          reason: 'Created',
          headers: [['X-Server', 'echo']],
          body: 'pong',
          size: 4,
          duration_ms: 9,
          error: null,
        }),
      } as Response;
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const editor = () =>
  screen.getByRole('textbox', { name: t('repeater.request') }) as HTMLTextAreaElement;

describe('RepeaterTab', () => {
  it('shows guidance when there are no tabs', () => {
    render(<RepeaterTabView />);
    expect(screen.getByText(t('repeater.noTabs'))).toBeTruthy();
  });

  it('creates a new empty tab with +', async () => {
    const user = userEvent.setup();
    render(<RepeaterTabView />);
    await user.click(screen.getByRole('button', { name: '+' }));
    expect(editor().value).toContain('GET / HTTP/1.1');
  });

  it('picks up a request pushed from the Proxy tab', async () => {
    render(<RepeaterTabView />);
    sendToRepeater(flow);
    await waitFor(() => expect(editor().value).toContain('GET /hello'));
    expect(screen.getByDisplayValue('http://echo.test')).toBeTruthy();
  });

  it('sends the edited request and shows the response', async () => {
    const user = userEvent.setup();
    render(<RepeaterTabView />);
    sendToRepeater(flow);
    await waitFor(() => expect(editor()).toBeTruthy());

    await user.clear(editor());
    await user.type(
      editor(),
      'POST /submit HTTP/1.1{enter}Host: echo.test{enter}{enter}a=1',
    );
    await user.click(screen.getByRole('button', { name: t('repeater.send') }));

    await waitFor(() => expect(screen.getByText(/pong/)).toBeTruthy());
    expect(sent[0]).toEqual({
      url: 'http://echo.test/submit',
      method: 'POST',
      headers: [['Host', 'echo.test']],
      body: 'a=1',
    });
    expect(screen.getByText(/201 · 4 B · 9 ms/)).toBeTruthy();
  });

  it('reports malformed requests without calling the engine', async () => {
    const user = userEvent.setup();
    render(<RepeaterTabView />);
    sendToRepeater(flow);
    await waitFor(() => expect(editor()).toBeTruthy());
    await user.clear(editor());
    await user.type(editor(), 'OOPS');
    await user.click(screen.getByRole('button', { name: t('repeater.send') }));
    expect(await screen.findByText(t('parse.badRequestLine'))).toBeTruthy();
    expect(sent).toHaveLength(0);
  });

  it('supports multiple independent tabs', async () => {
    const user = userEvent.setup();
    render(<RepeaterTabView />);
    sendToRepeater(flow);
    sendToRepeater({ ...flow, id: 'f2', path: '/second' });
    // wait on the DOM, not the store, so React effects have flushed
    await waitFor(() => expect(editor()?.value).toContain('/second'));
    expect(getTabs()).toHaveLength(2);
    const [helloTab] = screen
      .getAllByRole('button')
      .filter((b) => b.textContent === 'GET /hello×');
    await user.click(helloTab);
    expect(editor().value).toContain('/hello');
  });

  it('closes a tab', async () => {
    const user = userEvent.setup();
    render(<RepeaterTabView />);
    sendToRepeater(flow);
    await waitFor(() => expect(editor()).toBeTruthy());
    await user.click(screen.getByLabelText(t('repeater.closeTab', { title: 'GET /hello' })));
    await waitFor(() => expect(getTabs()).toHaveLength(0));
  });
});

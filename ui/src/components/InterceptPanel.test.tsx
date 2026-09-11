/** Renders the real InterceptPanel and asserts the edit/forward/drop flow. */
import {cleanup, screen, waitFor } from '@testing-library/react';
import { renderWithI18n as render, t } from '../test-utils';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InterceptPanel } from './InterceptPanel';
import type { InterceptRules, PausedFlow } from '../api/types';

const rules: InterceptRules = {
  enabled: true,
  intercept_requests: true,
  intercept_responses: false,
  host_filter: null,
};

const pausedFlow: PausedFlow = {
  id: 'p1',
  phase: 'request',
  method: 'GET',
  scheme: 'http',
  host: 'example.com',
  port: 80,
  path: '/original',
  http_version: 'HTTP/1.1',
  request_headers: [['Host', 'example.com']],
  request_body: '',
};

let calls: { url: string; init?: RequestInit }[] = [];

/** The raw-HTTP editor (the host-filter input is also a textbox). */
const editorEl = () =>
  document.querySelector('textarea.intercept-editor') as HTMLTextAreaElement;

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ ok: true, forwarded: 1 }),
      } as Response;
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('InterceptPanel', () => {
  it('shows an idle message when nothing is paused', () => {
    render(
      <InterceptPanel
        rules={rules}
        paused={[]}
        onToggle={() => {}}
        onResolved={() => {}}
      />,
    );
    expect(screen.getByText(t('intercept.idleOn'))).toBeTruthy();
    expect(
      screen.getByRole('button', { name: t('intercept.forward') }).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('renders the paused request as editable raw HTTP', () => {
    render(
      <InterceptPanel
        rules={rules}
        paused={[pausedFlow]}
        onToggle={() => {}}
        onResolved={() => {}}
      />,
    );
    const editor = editorEl();
    expect(editor.value).toContain('GET /original HTTP/1.1');
    expect(editor.value).toContain('Host: example.com');
  });

  it('forwards unchanged requests without edits', async () => {
    const onResolved = vi.fn();
    const user = userEvent.setup();
    render(
      <InterceptPanel
        rules={rules}
        paused={[pausedFlow]}
        onToggle={() => {}}
        onResolved={onResolved}
      />,
    );
    await user.click(screen.getByRole('button', { name: t('intercept.forward') }));
    await waitFor(() => expect(onResolved).toHaveBeenCalledWith('p1'));
    const call = calls.find((c) => c.url.includes('/forward'));
    expect(call?.init?.body).toBe('{}');
  });

  it('sends parsed edits when the raw request was modified', async () => {
    const user = userEvent.setup();
    render(
      <InterceptPanel
        rules={rules}
        paused={[pausedFlow]}
        onToggle={() => {}}
        onResolved={() => {}}
      />,
    );
    const editor = editorEl();
    await user.clear(editor);
    await user.type(
      editor,
      'POST /hacked HTTP/1.1{enter}Host: example.com{enter}{enter}x=1',
    );
    await user.click(screen.getByRole('button', { name: t('intercept.forward') }));

    await waitFor(() =>
      expect(calls.some((c) => c.url.includes('/forward'))).toBe(true),
    );
    const body = JSON.parse(
      String(calls.find((c) => c.url.includes('/forward'))!.init!.body),
    );
    expect(body.method).toBe('POST');
    expect(body.path).toBe('/hacked');
    expect(body.request_body).toBe('x=1');
  });

  it('drops the paused flow', async () => {
    const onResolved = vi.fn();
    const user = userEvent.setup();
    render(
      <InterceptPanel
        rules={rules}
        paused={[pausedFlow]}
        onToggle={() => {}}
        onResolved={onResolved}
      />,
    );
    await user.click(screen.getByRole('button', { name: t('intercept.drop') }));
    await waitFor(() => expect(onResolved).toHaveBeenCalledWith('p1'));
    expect(calls.some((c) => c.url.endsWith('/p1/drop'))).toBe(true);
  });

  it('toggles intercept on/off', async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(
      <InterceptPanel
        rules={rules}
        paused={[]}
        onToggle={onToggle}
        onResolved={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: t('intercept.on') }));
    expect(onToggle).toHaveBeenCalledWith({ enabled: false });
  });

  it('surfaces parse errors instead of forwarding garbage', async () => {
    const user = userEvent.setup();
    render(
      <InterceptPanel
        rules={rules}
        paused={[pausedFlow]}
        onToggle={() => {}}
        onResolved={() => {}}
      />,
    );
    await user.clear(editorEl());
    await user.type(editorEl(), 'GARBAGE');
    await user.click(screen.getByRole('button', { name: t('intercept.forward') }));
    expect(await screen.findByText(t('parse.badRequestLine'))).toBeTruthy();
    expect(calls.some((c) => c.url.includes('/forward'))).toBe(false);
  });

  it('shows the queue length', () => {
    render(
      <InterceptPanel
        rules={rules}
        paused={[pausedFlow, { ...pausedFlow, id: 'p2' }]}
        onToggle={() => {}}
        onResolved={() => {}}
      />,
    );
    expect(screen.getByText(t('intercept.queued', { count: 2 }))).toBeTruthy();
  });
});

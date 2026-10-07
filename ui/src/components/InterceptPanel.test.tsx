/** Renders the real InterceptPanel and asserts the edit/forward/drop flow. */
import {cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { fireShortcut, renderWithI18n as render, t } from '../test-utils';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InterceptPanel } from './InterceptPanel';
import type { InterceptRules, PausedFlow } from '../api/types';
import { getTabs, resetTabs } from '../tabs/replayStore';
import { resetTarget, subscribeTarget, type FuzzerTarget } from '../tabs/fuzzerStore';

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
  window.localStorage.removeItem('lanius.intercept.queueWidth');
  resetTabs();
  resetTarget();
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
  it('sends the held draft to Replay and Fuzzer through shortcuts without forwarding it', () => {
    render(<InterceptPanel rules={rules} paused={[pausedFlow]} onToggle={() => {}} onResolved={() => {}} />);
    const draft = 'POST /edited HTTP/1.1\nHost: example.com\n\nchanged';
    fireEvent.change(editorEl(), { target: { value: draft } });
    fireShortcut('request.sendToReplay', editorEl());
    expect(getTabs()[0]).toMatchObject({ url: 'http://example.com', text: draft });
    const sent: { target: FuzzerTarget | null } = { target: null };
    const unsubscribe = subscribeTarget((target) => { sent.target = target; });
    fireShortcut('request.sendToFuzzer', editorEl());
    unsubscribe();
    expect(sent.target).toMatchObject({ url: 'http://example.com', template: draft });
    expect(calls.some(({ url }) => url.includes('/forward'))).toBe(false);
  });

  it('opens the history actions on a held draft and sends its edits to Replay', async () => {
    const user = userEvent.setup();
    render(<InterceptPanel rules={rules} paused={[pausedFlow]} onToggle={() => {}} onResolved={() => {}} />);
    fireEvent.change(editorEl(), {
      target: { value: 'POST /edited?x=1 HTTP/1.1\r\nHost: example.com\r\nX-Edit: yes\r\n\r\nbody=changed' },
    });

    fireEvent.contextMenu(editorEl());
    expect(screen.getByRole('menuitem', { name: t('menu.sendToReplay') })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: t('menu.sendToFuzzer') })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: t('menu.addToScope') })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: t('menu.copyUrl') })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: t('menu.copyAs') })).toBeTruthy();
    await user.click(screen.getByRole('menuitem', { name: t('menu.sendToReplay') }));

    expect(getTabs()[0].url).toBe('http://example.com');
    expect(getTabs()[0].text).toContain('POST /edited?x=1 HTTP/1.1');
    expect(getTabs()[0].text).toContain('body=changed');
    expect(calls.some(({ url }) => url.includes('/forward'))).toBe(false);
  });

  it('uses the right-clicked queue item and its draft for Fuzzer', async () => {
    const second = { ...pausedFlow, id: 'p2', path: '/second' };
    const sent: { target: FuzzerTarget | null } = { target: null };
    const unsubscribe = subscribeTarget((target) => { sent.target = target; });
    const user = userEvent.setup();
    render(<InterceptPanel rules={rules} paused={[pausedFlow, second]} onToggle={() => {}} onResolved={() => {}} />);
    const queue = screen.getByLabelText(t('intercept.queueLabel'));
    await user.click(within(queue).getByRole('button', { name: /second/ }));
    fireEvent.change(editorEl(), {
      target: { value: 'PUT /second-edited HTTP/1.1\r\nHost: example.com\r\n\r\nchanged' },
    });
    await user.click(within(queue).getByRole('button', { name: /original/ }));

    fireEvent.contextMenu(within(queue).getByRole('button', { name: /second/ }));
    await user.click(screen.getByRole('menuitem', { name: t('menu.sendToFuzzer') }));

    expect(sent.target?.template).toContain('PUT /second-edited HTTP/1.1');
    expect(sent.target?.template).toContain('changed');
    unsubscribe();
  });

  it('sends the request when the response is intercepted', async () => {
    const user = userEvent.setup();
    render(<InterceptPanel rules={rules} paused={[{
      ...pausedFlow, phase: 'response', request_body: 'request-data',
      status_code: 200, response_headers: [['Content-Type', 'text/plain']],
      response_body: 'response-data',
    }]} onToggle={() => {}} onResolved={() => {}} />);

    fireEvent.contextMenu(editorEl());
    await user.click(screen.getByRole('menuitem', { name: t('menu.sendToReplay') }));

    expect(getTabs()[0].text).toContain('request-data');
    expect(getTabs()[0].text).not.toContain('response-data');
  });

  it('uses the selected original request variant when right-clicking its editor', async () => {
    const original = {
      method: 'GET', scheme: 'https', host: 'original.test', port: 443,
      path: '/before', http_version: 'HTTP/1.1',
      headers: [['Host', 'original.test']] as [string, string][],
      body: 'original-body', charset: 'utf-8', content_encoding: null,
      body_decoded: false, decode_error: null,
    };
    const user = userEvent.setup();
    render(<InterceptPanel rules={rules} paused={[{
      ...pausedFlow, request_variants: { original, auto_modified: original },
    }]} onToggle={() => {}} onResolved={() => {}} />);

    await user.click(screen.getByRole('tab', { name: t('intercept.view.original') }));
    fireEvent.contextMenu(editorEl());
    await user.click(screen.getByRole('menuitem', { name: t('menu.sendToReplay') }));

    expect(getTabs()[0].url).toBe('https://original.test');
    expect(getTabs()[0].text).toContain('GET /before HTTP/1.1');
    expect(getTabs()[0].text).toContain('original-body');
  });

  it('uses an edited request for scope and Copy as actions', async () => {
    const user = userEvent.setup();
    render(<InterceptPanel rules={rules} paused={[pausedFlow]} onToggle={() => {}} onResolved={() => {}} />);
    fireEvent.change(editorEl(), {
      target: { value: 'POST /edited?x=1 HTTP/1.1\r\nHost: example.com\r\nX-Edit: yes\r\n\r\nbody=changed' },
    });

    fireEvent.contextMenu(editorEl());
    await user.click(screen.getByRole('menuitem', { name: t('menu.addToScope') }));
    await waitFor(() => expect(calls.some(({ url }) => url.endsWith('/api/scope/from-url'))).toBe(true));
    const scopeCall = calls.find(({ url }) => url.endsWith('/api/scope/from-url'))!;
    expect(JSON.parse(String(scopeCall.init?.body)).url).toBe('http://example.com/edited?x=1');

    fireEvent.contextMenu(editorEl());
    await user.hover(screen.getByRole('menuitem', { name: t('menu.copyAs') }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'curl' }));
    await waitFor(() => expect(calls.some(({ url }) => url.endsWith('/api/codegen'))).toBe(true));
    const codegenCall = calls.find(({ url }) => url.endsWith('/api/codegen'))!;
    expect(JSON.parse(String(codegenCall.init?.body))).toMatchObject({
      kind: 'curl', url: 'http://example.com/edited?x=1', method: 'POST',
      body: 'body=changed',
    });
  });

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

  it('lists the queue and shows whichever is picked', async () => {
    // With several held, only the first was ever shown, so a request
    // further down the queue could not be read or edited at all.
    const user = userEvent.setup();
    const second: PausedFlow = {
      ...pausedFlow,
      id: 'p2',
      method: 'POST',
      path: '/second',
      request_body: 'from the second',
    };
    const third: PausedFlow = {
      ...pausedFlow,
      id: 'p3',
      phase: 'response',
      path: '/third',
      status_code: 500,
    };
    render(
      <InterceptPanel
        rules={rules}
        paused={[pausedFlow, second, third]}
        onToggle={() => {}}
        onResolved={() => {}}
      />,
    );

    const queue = screen.getByLabelText(t('intercept.queueLabel'));
    expect(within(queue).getAllByRole('button')).toHaveLength(3);
    // The first is shown until another is chosen.
    expect(editorEl().value).toContain('/original');

    await user.click(within(queue).getByRole('button', { name: /second/ }));
    await waitFor(() => expect(editorEl().value).toContain('from the second'));
    expect(editorEl().value).toContain('/second');

    // Responses are in the queue too, and marked as such.
    await user.click(within(queue).getByRole('button', { name: /third/ }));
    await waitFor(() => expect(editorEl().value).toContain('500'));
  });

  it('keeps a separate edited draft for each held message', async () => {
    const user = userEvent.setup();
    const second: PausedFlow = { ...pausedFlow, id: 'p2', path: '/second' };
    render(<InterceptPanel rules={rules} paused={[pausedFlow, second]}
      onToggle={() => {}} onResolved={() => {}} />);
    fireEvent.change(editorEl(), { target: { value: 'POST /first HTTP/1.1\r\nHost: example.com\r\n\r\nfirst' } });
    const queue = screen.getByLabelText(t('intercept.queueLabel'));
    await user.click(within(queue).getByRole('button', { name: /second/ }));
    fireEvent.change(editorEl(), { target: { value: 'POST /second HTTP/1.1\r\nHost: example.com\r\n\r\nsecond' } });
    await user.click(within(queue).getByRole('button', { name: /original/ }));
    expect(editorEl().value).toContain('/first');
    await user.click(within(queue).getByRole('button', { name: /second/ }));
    expect(editorEl().value).toContain('second');
  });

  it('shows original and automatic versions read-only while forwarding the edited draft', async () => {
    const user = userEvent.setup();
    const flow: PausedFlow = {
      ...pausedFlow, path: '/automatic',
      request_variants: {
        original: { method: 'GET', scheme: 'http', host: 'example.com', port: 80,
          path: '/original', http_version: 'HTTP/1.1', headers: [['Host', 'example.com']],
          body: '', charset: 'utf-8', content_encoding: null, body_decoded: false, decode_error: null },
        auto_modified: { method: 'GET', scheme: 'http', host: 'example.com', port: 80,
          path: '/automatic', http_version: 'HTTP/1.1', headers: [['Host', 'example.com']],
          body: '', charset: 'utf-8', content_encoding: null, body_decoded: false, decode_error: null },
      },
    };
    render(<InterceptPanel rules={rules} paused={[flow]}
      onToggle={() => {}} onResolved={() => {}} />);
    expect(editorEl().value).toContain('/automatic');
    fireEvent.change(editorEl(), { target: { value: 'POST /manual HTTP/1.1\r\nHost: example.com\r\n\r\n' } });
    await user.click(screen.getByRole('tab', { name: t('intercept.view.original') }));
    expect(editorEl().value).toContain('/original');
    expect(editorEl().readOnly).toBe(true);
    await user.click(screen.getByRole('tab', { name: t('intercept.view.auto_modified') }));
    expect(editorEl().value).toContain('/automatic');
    expect(editorEl().readOnly).toBe(true);
    await user.click(screen.getByRole('tab', {
      name: (name) => name.startsWith(t('intercept.view.modified')),
    }));
    expect(editorEl().value).toContain('/manual');
    expect(editorEl().readOnly).toBe(false);
    await user.click(screen.getByRole('tab', { name: t('intercept.view.original') }));
    await user.click(screen.getByRole('button', { name: t('intercept.forward') }));
    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/p1/forward'))).toBe(true));
    const body = JSON.parse(String(calls.find((call) => call.url.endsWith('/p1/forward'))?.init?.body));
    expect(body.method).toBe('POST');
    expect(body.path).toBe('/manual');
  });

  it('shows response versions before and after automatic changes', async () => {
    const user = userEvent.setup();
    const flow: PausedFlow = {
      ...pausedFlow, phase: 'response', status_code: 418, reason: 'Teapot',
      response_headers: [['Content-Type', 'text/plain']], response_body: 'automatic',
      response_variants: {
        original: { http_version: 'HTTP/1.1', status_code: 200, reason: 'OK',
          headers: [['Content-Type', 'text/plain']], body: 'original' },
        auto_modified: { http_version: 'HTTP/1.1', status_code: 418, reason: 'Teapot',
          headers: [['Content-Type', 'text/plain']], body: 'automatic' },
      },
    };
    render(<InterceptPanel rules={rules} paused={[flow]}
      onToggle={() => {}} onResolved={() => {}} />);
    await user.click(screen.getByRole('tab', { name: t('intercept.view.original') }));
    expect(editorEl().value).toContain('200 OK');
    expect(editorEl().value).toContain('original');
    await user.click(screen.getByRole('tab', { name: t('intercept.view.auto_modified') }));
    expect(editorEl().value).toContain('418 Teapot');
    expect(editorEl().value).toContain('automatic');
  });

  it('forwards a draft before turning interception off', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<InterceptPanel rules={rules} paused={[pausedFlow]}
      onToggle={onToggle} onResolved={() => {}} />);
    fireEvent.change(editorEl(), { target: { value: 'POST /edited HTTP/1.1\r\nHost: example.com\r\n\r\n' } });
    await user.click(screen.getByRole('button', { name: t('intercept.on') }));
    await waitFor(() => expect(onToggle).toHaveBeenCalledWith({ enabled: false }));
    expect(JSON.parse(String(calls.find((call) => call.url.endsWith('/p1/forward'))?.init?.body)).path).toBe('/edited');
  });

  it('forwards every held draft and validates all drafts before releasing any', async () => {
    const user = userEvent.setup();
    const second: PausedFlow = { ...pausedFlow, id: 'p2', path: '/second' };
    render(<InterceptPanel rules={rules} paused={[pausedFlow, second]}
      onToggle={() => {}} onResolved={() => {}} />);
    const queue = screen.getByLabelText(t('intercept.queueLabel'));
    fireEvent.change(editorEl(), { target: { value: 'POST /first HTTP/1.1\r\nHost: example.com\r\n\r\n' } });
    await user.click(within(queue).getByRole('button', { name: /second/ }));
    fireEvent.change(editorEl(), { target: { value: 'INVALID' } });
    await user.click(screen.getByRole('button', { name: t('intercept.forwardAll') }));
    expect(await screen.findByText(t('parse.badRequestLine'))).toBeTruthy();
    expect(calls.some((call) => call.url.includes('/forward'))).toBe(false);
    fireEvent.change(editorEl(), { target: { value: 'POST /second HTTP/1.1\r\nHost: example.com\r\n\r\n' } });
    await user.click(screen.getByRole('button', { name: t('intercept.forwardAll') }));
    await waitFor(() => expect(calls.filter((call) => call.url.endsWith('/forward'))).toHaveLength(2));
    expect(calls.some((call) => call.url.endsWith('/forward-all'))).toBe(false);
    expect(JSON.parse(String(calls.find((call) => call.url.endsWith('/p1/forward'))?.init?.body)).path).toBe('/first');
    expect(JSON.parse(String(calls.find((call) => call.url.endsWith('/p2/forward'))?.init?.body)).path).toBe('/second');
  });

  it('moves through the queue with arrow keys and highlights editable HTTP', async () => {
    const user = userEvent.setup();
    render(<InterceptPanel rules={rules}
      paused={[pausedFlow, { ...pausedFlow, id: 'p2', method: 'POST', path: '/next',
        request_headers: [['Content-Type', 'application/json']], request_body: '{"ok":true}' }]}
      onToggle={() => {}} onResolved={() => {}} />);
    const queue = screen.getByLabelText(t('intercept.queueLabel'));
    const buttons = within(queue).getAllByRole('button');
    buttons[0].focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(buttons[1]);
    await waitFor(() => expect(editorEl().value).toContain('/next'));
    expect(editorEl().getAttribute('wrap')).toBe('soft');
    expect(document.querySelector('.highlight-editor-overlay .hljs-keyword')?.textContent).toBe('POST');
    expect(document.querySelector('.highlight-editor-overlay .hljs-attr')?.textContent).toBe('Content-Type');
    expect(document.querySelector('.highlight-editor-overlay')?.textContent).toBe(editorEl().value);
    await user.keyboard('{ArrowUp}');
    await waitFor(() => expect(editorEl().value).toContain('/original'));
  });

  it('acts on the request being shown, not just the first', async () => {
    // Forwarding the wrong flow would be worse than not offering the list.
    const user = userEvent.setup();
    const second: PausedFlow = { ...pausedFlow, id: 'p2', path: '/second' };
    render(
      <InterceptPanel
        rules={rules}
        paused={[pausedFlow, second]}
        onToggle={() => {}}
        onResolved={() => {}}
      />,
    );

    const queue = screen.getByLabelText(t('intercept.queueLabel'));
    await user.click(within(queue).getByRole('button', { name: /second/ }));
    await waitFor(() => expect(editorEl().value).toContain('/second'));

    await user.click(screen.getByRole('button', { name: t('intercept.forward') }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes('/api/intercept/p2/forward'))).toBe(
        true,
      ),
    );
    expect(calls.some((c) => c.url.includes('/api/intercept/p1/forward'))).toBe(
      false,
    );
  });

  it('shows a resizable queue for a single held request and remembers its width', async () => {
    const view = render(
      <InterceptPanel
        rules={rules}
        paused={[pausedFlow]}
        onToggle={() => {}}
        onResolved={() => {}}
      />,
    );
    expect(within(screen.getByLabelText(t('intercept.queueLabel'))).getAllByRole('button')).toHaveLength(1);
    const divider = screen.getByRole('separator', { name: t('intercept.resizeQueue') });
    expect(divider.getAttribute('aria-valuenow')).toBe('300');
    fireEvent.keyDown(divider, { key: 'ArrowRight' });
    await waitFor(() => expect(window.localStorage.getItem('lanius.intercept.queueWidth')).toBe('316'));
    view.unmount();
    render(<InterceptPanel rules={rules} paused={[pausedFlow]} onToggle={() => {}} onResolved={() => {}} />);
    expect(screen.getByRole('separator', { name: t('intercept.resizeQueue') }).getAttribute('aria-valuenow')).toBe('316');
  });

  it('filters the queue like History without releasing hidden requests', async () => {
    const user = userEvent.setup();
    const hidden = { ...pausedFlow, id: 'p2', path: '/hidden.js', method: 'POST', in_scope: false };
    const visible = { ...pausedFlow, id: 'p3', path: '/visible.js', method: 'POST',
      status_code: 404, in_scope: true, bookmarked: true, annotation_color: 'green' as const };
    const onResolved = vi.fn();
    render(<InterceptPanel rules={rules} paused={[pausedFlow, hidden, visible]}
      onToggle={() => {}} onResolved={onResolved} />);

    await user.click(screen.getByRole('button', { name: t('filter.button') }));
    const dialog = screen.getByRole('dialog', { name: t('intercept.filterTitle') });
    await user.click(within(dialog).getByLabelText('POST'));
    await user.click(within(dialog).getByLabelText('4xx'));
    await user.click(within(dialog).getByLabelText(t('filter.inScopeOnly')));
    await user.click(within(dialog).getByLabelText(t('history.bookmarkedOnly')));
    await userEvent.selectOptions(within(dialog).getByLabelText(t('history.highlight')), 'green');
    await user.click(within(dialog).getByRole('button', { name: t('filter.apply') }));
    const queue = screen.getByLabelText(t('intercept.queueLabel'));
    expect(within(queue).getAllByRole('button')).toHaveLength(1);
    expect(within(queue).getByRole('button', { name: /visible/ })).toBeTruthy();
    expect(editorEl().value).toContain('/visible.js');
    expect(screen.getByText(t('intercept.visibleQueued', { visible: 1, total: 3 }))).toBeTruthy();

    await user.click(screen.getByRole('button', { name: t('intercept.forwardAll') }));
    await waitFor(() => expect(onResolved).toHaveBeenCalledWith('*'));
    expect(calls.some((call) => call.url.endsWith('/api/intercept/forward-all'))).toBe(true);
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

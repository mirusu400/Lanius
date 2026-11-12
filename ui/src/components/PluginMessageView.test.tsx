/** Plugin tabs beside Pretty, Raw and Hex.
 *
 * A plugin renders a message its own way (decrypting it, say). Where Raw
 * is editable and the plugin can reverse its rendering, edits made in the
 * plugin tab go back through the plugin and replace Raw.
 */
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PluginMessageViewContribution } from '../api/types';
import { renderWithI18n, t } from '../test-utils';
import { RequestEditor } from './RequestEditor';
import { ResponseInspector } from './ResponseInspector';

const DECRYPT: PluginMessageViewContribution = {
  id: 'e2e.decrypt',
  plugin: 'e2e',
  title: 'Decrypted',
  description: null,
  sides: ['request', 'response'],
  editable: true,
};
const STATUS: PluginMessageViewContribution = {
  id: 'e2e.status',
  plugin: 'e2e',
  title: 'Status only',
  description: null,
  sides: ['response'],
  editable: false,
};

// The "cipher" reverses the body, so expectations stay readable.
const RAW = 'POST /e2e HTTP/1.1\nHost: x.test\n\ncba';
const reverse = (text: string) => [...text].reverse().join('');
const bodyOf = (raw: string) => raw.slice(raw.indexOf('\n\n') + 2);

type Call = { url: string; body: Record<string, unknown> };
let calls: Call[];
let views: PluginMessageViewContribution[];

function json(value: unknown, status = 200) {
  return { ok: status < 400, status, statusText: '', json: async () => value, clone() { return this; } } as unknown as Response;
}

beforeEach(() => {
  calls = [];
  views = [DECRYPT, STATUS];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    calls.push({ url, body });
    if (url.endsWith('/api/plugin-contributions')) return json({ actions: [], message_views: views });
    const message = body.message as { raw: string; side: string };
    if (url.includes('/e2e.decrypt/render')) {
      const plain = bodyOf(message.raw);
      return json({ text: plain ? reverse(plain) : null });
    }
    if (url.includes('/e2e.decrypt/apply')) {
      if (body.text === 'bad') return json({ detail: 'cannot encrypt' }, 400);
      const head = message.raw.slice(0, message.raw.indexOf('\n\n') + 2);
      return json({ raw: head + reverse(String(body.text)) });
    }
    if (url.includes('/e2e.status/render')) return json({ text: message.raw.split('\n')[0] });
    return json({ detail: 'unexpected' }, 500);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function Replay({ initial = RAW, onRaw }: { initial?: string; onRaw?: (raw: string) => void }) {
  const [value, setValue] = useState(initial);
  return <>
    <RequestEditor value={value} onChange={(next) => { setValue(next); onRaw?.(next); }}
      label="request" initialView="raw" pluginLocation="replay" />
    <output data-testid="raw">{value}</output>
  </>;
}

describe('request editor plugin tabs', () => {
  it('lists only views for requests, after the built-in ones', async () => {
    renderWithI18n(<Replay />);
    await screen.findByRole('tab', { name: 'Decrypted' });
    expect(screen.getAllByRole('tab').map((node) => node.textContent)).toEqual([
      t('detail.view.parsed'), t('detail.view.raw'), t('detail.view.hex'), 'Decrypted',
    ]);
  });

  it('offers no plugin tabs where the editor is not given a location', () => {
    renderWithI18n(<RequestEditor value={RAW} onChange={() => {}} label="request" />);
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(calls).toHaveLength(0);
  });

  it('renders the message through the plugin and applies edits back to Raw', async () => {
    const onRaw = vi.fn();
    renderWithI18n(<Replay onRaw={onRaw} />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Decrypted' }));

    const editor = await screen.findByRole('textbox', { name: 'Decrypted' }) as HTMLTextAreaElement;
    expect(editor.value).toBe('abc');
    const render = calls.find((call) => call.url.includes('/render'));
    expect(render?.body.message).toMatchObject({ side: 'request', location: 'replay', raw: RAW, editable: true });

    fireEvent.change(editor, { target: { value: 'hello' } });
    expect(screen.getByText(t('plugins.messageView.applying'))).toBeTruthy();
    await waitFor(() => expect(onRaw).toHaveBeenCalledWith('POST /e2e HTTP/1.1\nHost: x.test\n\nolleh'));
    expect(screen.getByText(t('plugins.messageView.applied'))).toBeTruthy();
    // Raw changed because of our own edit: the text being typed is kept,
    // not re-rendered under the cursor.
    expect(editor.value).toBe('hello');
    expect(calls.filter((call) => call.url.includes('/render'))).toHaveLength(1);

    await userEvent.click(screen.getByRole('tab', { name: t('detail.view.raw') }));
    expect(screen.getByTestId('raw').textContent).toBe('POST /e2e HTTP/1.1\nHost: x.test\n\nolleh');
  });

  it('explains when a view does not apply', async () => {
    renderWithI18n(<Replay initial={'GET / HTTP/1.1\nHost: x.test\n\n'} />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Decrypted' }));
    expect(await screen.findByText(t('plugins.messageView.notApplicable', { name: 'Decrypted' }))).toBeTruthy();
  });

  it('leaves Raw alone and says so when the plugin cannot apply an edit', async () => {
    const onRaw = vi.fn();
    renderWithI18n(<Replay onRaw={onRaw} />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Decrypted' }));
    const editor = await screen.findByRole('textbox', { name: 'Decrypted' });
    fireEvent.change(editor, { target: { value: 'bad' } });
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent', t('plugins.messageView.applyFailed', { message: 'cannot encrypt' }),
    );
    expect(onRaw).not.toHaveBeenCalled();
    expect(screen.getByTestId('raw').textContent).toBe(RAW);
  });

  it('falls back to Raw when the plugin providing the open view goes away', async () => {
    renderWithI18n(<Replay />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Decrypted' }));
    await screen.findByRole('textbox', { name: 'Decrypted' });

    views = [];
    await act(async () => { window.dispatchEvent(new Event('lanius.pluginsChanged')); });
    await waitFor(() => expect(screen.queryByRole('tab', { name: 'Decrypted' })).toBeNull());
    expect(screen.getByRole('tab', { name: t('detail.view.raw') }).getAttribute('aria-selected')).toBe('true');
    expect((screen.getByRole('textbox', { name: 'request' }) as HTMLTextAreaElement).value).toBe(RAW);
  });
});

describe('response plugin tabs', () => {
  it('shows read-only plugin views for responses with find support', async () => {
    const raw = 'HTTP/1.1 200 OK\nContent-Type: text/plain\n\ndlrow olleh';
    renderWithI18n(<ResponseInspector flowId="r-1" raw={raw} empty="none" pluginLocation="replay" />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Decrypted' }));
    await waitFor(() => expect(document.querySelector('.plugin-message-view-text')?.textContent).toBe('hello world'));
    expect(screen.queryByRole('textbox', { name: 'Decrypted' })).toBeNull();
    expect(calls.find((call) => call.url.includes('/render'))?.body.message)
      .toMatchObject({ side: 'response', location: 'replay', flow_id: 'r-1', editable: false });

    await userEvent.click(screen.getByRole('tab', { name: 'Status only' }));
    await waitFor(() => expect(document.querySelector('.plugin-message-view-text')?.textContent).toBe('HTTP/1.1 200 OK'));
  });

  it('hands plugins the complete message when the display copy is cut short', async () => {
    renderWithI18n(<ResponseInspector flowId="r-1" raw={'HTTP/1.1 200 OK\n\ncb…'} empty="none"
      pluginLocation="replay" pluginMessage={{ raw: 'HTTP/1.1 200 OK\n\ncba', bodyTruncated: false }} />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Decrypted' }));
    await waitFor(() => expect(document.querySelector('.plugin-message-view-text')?.textContent).toBe('abc'));
  });
});

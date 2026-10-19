/** Multiple proxy listener controls in Settings. */
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ListenersState } from '../api/types';
import { ListenerSection } from './settings/ListenerSection';
import { renderWithI18n as render, t } from '../test-utils';

let state: ListenersState;
let requests: { method: string; url: string; body?: Record<string, unknown> }[];
let rejectWith: string | null;

function listener(id: string, port: number, primary: boolean) {
  return {
    id,
    host: '127.0.0.1',
    port,
    running: true,
    error: null,
    exposed: false,
    primary,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers({ 'Content-Type': 'application/json' }),
  } as unknown as Response;
}

beforeEach(() => {
  state = {
    listeners: [listener('first', 8080, true)],
    primary_id: 'first',
    addresses: [
      { host: '127.0.0.1', label: 'This machine only' },
      { host: '0.0.0.0', label: 'All interfaces' },
      { host: '192.168.1.42', label: '192.168.1.42' },
    ],
  };
  requests = [];
  rejectWith = null;

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body
        ? JSON.parse(String(init.body)) as Record<string, unknown>
        : undefined;
      if (!url.includes('/api/listeners')) return jsonResponse({});
      requests.push({ method, url, body });
      if (method !== 'GET' && rejectWith) {
        return jsonResponse({ detail: rejectWith }, 409);
      }

      const primaryMatch = url.match(/\/api\/listeners\/([^/]+)\/primary/);
      const itemMatch = url.match(/\/api\/listeners\/([^/]+)$/);
      if (method === 'POST' && primaryMatch) {
        const id = decodeURIComponent(primaryMatch[1]);
        state = {
          ...state,
          primary_id: id,
          listeners: state.listeners.map((item) => ({ ...item, primary: item.id === id })),
        };
      } else if (method === 'POST') {
        state = {
          ...state,
          listeners: [
            ...state.listeners,
            {
              id: 'second',
              host: String(body?.host),
              port: Number(body?.port),
              running: true,
              error: null,
              exposed: body?.host === '0.0.0.0',
              primary: false,
            },
          ],
        };
      } else if (method === 'PATCH' && itemMatch) {
        const id = decodeURIComponent(itemMatch[1]);
        state = {
          ...state,
          listeners: state.listeners.map((item) => item.id === id
            ? { ...item, host: String(body?.host), port: Number(body?.port) }
            : item),
        };
      } else if (method === 'DELETE' && itemMatch) {
        const id = decodeURIComponent(itemMatch[1]);
        state = { ...state, listeners: state.listeners.filter((item) => item.id !== id) };
      }
      return jsonResponse(state);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const portInput = () => screen.getByLabelText(t('listener.port')) as HTMLInputElement;
const bindSelect = () => screen.getByLabelText(t('listener.bind')) as HTMLSelectElement;

describe('listener settings', () => {
  it('shows the configured listener and its primary role', async () => {
    render(<ListenerSection />);
    expect(await screen.findByText('127.0.0.1:8080')).toBeTruthy();
    expect(screen.getByText(t('listener.primary'))).toBeTruthy();
    expect(screen.getByRole('button', { name: t('listener.add') })).toBeTruthy();
  });

  it('adds another listener without replacing the first', async () => {
    const user = userEvent.setup();
    render(<ListenerSection />);
    await user.click(await screen.findByRole('button', { name: t('listener.add') }));
    await user.type(portInput(), '8090');
    await user.click(screen.getByRole('button', { name: t('listener.save') }));

    expect(await screen.findByText('127.0.0.1:8090')).toBeTruthy();
    expect(screen.getByText('127.0.0.1:8080')).toBeTruthy();
    expect(requests.some((request) => request.method === 'POST'
      && request.body?.port === 8090)).toBe(true);
  });

  it('edits one listener', async () => {
    const user = userEvent.setup();
    render(<ListenerSection />);
    await user.click(await screen.findByRole('button', { name: t('listener.edit') }));
    await user.clear(portInput());
    await user.type(portInput(), '8091');
    await user.click(screen.getByRole('button', { name: t('listener.save') }));

    expect(await screen.findByText('127.0.0.1:8091')).toBeTruthy();
    expect(requests.some((request) => request.method === 'PATCH')).toBe(true);
  });

  it('warns before adding a network-exposed listener', async () => {
    const user = userEvent.setup();
    render(<ListenerSection />);
    await user.click(await screen.findByRole('button', { name: t('listener.add') }));
    await user.selectOptions(bindSelect(), '0.0.0.0');
    expect(screen.getByText(t('listener.exposed'))).toBeTruthy();
  });

  it('can select a different primary listener', async () => {
    state = {
      ...state,
      listeners: [...state.listeners, listener('second', 8090, false)],
    };
    const user = userEvent.setup();
    render(<ListenerSection />);
    await user.click(await screen.findByRole('button', { name: t('listener.makePrimary') }));
    await waitFor(() => expect(state.primary_id).toBe('second'));
    expect(requests.some((request) => request.url.endsWith('/second/primary'))).toBe(true);
  });

  it('keeps the old collection when an add is rejected', async () => {
    const user = userEvent.setup();
    rejectWith = 'proxy port 127.0.0.1:9999 is unavailable';
    render(<ListenerSection />);
    await user.click(await screen.findByRole('button', { name: t('listener.add') }));
    await user.type(portInput(), '9999');
    await user.click(screen.getByRole('button', { name: t('listener.save') }));

    expect(await screen.findByText(t('listener.kept'))).toBeTruthy();
    expect(screen.getByText('127.0.0.1:8080')).toBeTruthy();
  });

  it('shows a listener-specific startup error', async () => {
    state.listeners[0] = {
      ...state.listeners[0],
      running: false,
      error: 'address already in use',
    };
    render(<ListenerSection />);
    expect(await screen.findByText(
      t('listener.down', { message: 'address already in use' }),
    )).toBeTruthy();
  });
});

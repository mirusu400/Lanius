import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithI18n as render } from '../test-utils';
import { usePluginActions } from './usePluginActions';

let requests: Array<{ url: string; init?: RequestInit }> = [];

function Harness() {
  const actions = usePluginActions();
  const menu = actions.buildMenu(['history', 'flow'], { flow_id: 'flow-1' });
  const item = menu?.items?.[0];
  return item ? <button onClick={item.onSelect}>{item.label}</button> : null;
}

beforeEach(() => {
  requests = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith('/api/plugin-contributions')) {
      return {
        ok: true,
        json: async () => ({
          actions: [{
            id: 'acme.inspect', plugin: 'acme', title: 'Inspect flow',
            description: null, locations: ['history'],
          }],
        }),
      } as Response;
    }
    return { ok: true, json: async () => ({ result: { ok: true } }) } as Response;
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('usePluginActions', () => {
  it('renders actions at their declared location and sends context', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(await screen.findByText('Inspect flow · acme'));

    await waitFor(() => expect(requests.some(({ url }) =>
      url.endsWith('/api/plugin-actions/acme.inspect/invoke'),
    )).toBe(true));
    const invocation = requests.find(({ url }) => url.endsWith('/api/plugin-actions/acme.inspect/invoke'))!;
    expect(JSON.parse(String(invocation.init?.body))).toEqual({
      context: { flow_id: 'flow-1', location: 'history' },
    });
  });

  it('confirms when a plugin action starts an active scan', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/api/plugin-contributions')) {
        return { ok: true, json: async () => ({ actions: [{
          id: 'acme.inspect', plugin: 'acme', title: 'Inspect flow',
          description: null, locations: ['history'],
        }] }) } as Response;
      }
      return { ok: true, json: async () => ({ result: {
        id: 'job-1', check_ids: ['acme.check'], status: 'pending',
      } }) } as Response;
    }));
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(await screen.findByText('Inspect flow · acme'));
    expect((await screen.findByRole('status')).textContent).toContain(
      'Active scan started. View progress in Issues.',
    );
  });
});

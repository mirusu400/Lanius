import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithI18n as render, t } from '../test-utils';
import { PluginLogConsole } from './PluginLogConsole';

let calls: Array<{ url: string; method?: string }> = [];
const clipboard = vi.fn(async (_text: string) => undefined);
let clipboardDescriptor: PropertyDescriptor | undefined;

function response(body: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body } as Response;
}

beforeEach(() => {
  calls = [];
  clipboard.mockClear();
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: clipboard },
  });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method });
    if (init?.method === 'DELETE') {
      return response({ plugin: 'demo', items: [], count: 0, next_sequence: 2, dropped: 0 });
    }
    const after = new URL(url).searchParams.get('after');
    return response({
      plugin: 'demo',
      items: after === '0' ? [
        { sequence: 1, timestamp: 1, plugin: 'demo', source: 'stdout', level: 'info', message: 'request marked' },
        { sequence: 2, timestamp: 2, plugin: 'demo', source: 'stderr', level: 'error', message: 'sample failure' },
      ] : [],
      count: after === '0' ? 2 : 0,
      next_sequence: 2,
      dropped: 3,
    });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  if (clipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, 'clipboard');
  }
});

describe('PluginLogConsole', () => {
  it('polls incrementally and filters by source, level, and text', async () => {
    const user = userEvent.setup();
    render(<PluginLogConsole plugin="demo" />);
    expect(await screen.findByText('request marked')).toBeTruthy();
    expect(screen.getByText('sample failure')).toBeTruthy();
    expect(screen.getByText(t('plugins.logsDropped', { count: 3 }))).toBeTruthy();
    expect(calls[0].url).toContain('after=0');

    await user.selectOptions(screen.getByLabelText(t('plugins.logSource')), 'stderr');
    expect(screen.queryByText('request marked')).toBeNull();
    expect(screen.getByText('sample failure')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText(t('plugins.logLevel')), 'info');
    expect(screen.queryByText('sample failure')).toBeNull();
    await user.selectOptions(screen.getByLabelText(t('plugins.logLevel')), 'all');
    await user.selectOptions(screen.getByLabelText(t('plugins.logSource')), 'all');
    await user.type(screen.getByLabelText(t('plugins.searchLogs')), 'marked');
    expect(screen.getByText('request marked')).toBeTruthy();
    expect(screen.queryByText('sample failure')).toBeNull();
  });

  it('pauses, copies visible output, toggles wrapping, and clears logs separately', async () => {
    const user = userEvent.setup();
    // userEvent installs its own clipboard during setup, so install the spy
    // afterwards to observe the component's browser API call.
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboard },
    });
    render(<PluginLogConsole plugin="demo" />);
    await screen.findByText('request marked');
    await user.click(screen.getByText(t('common.pause')));
    expect(screen.getByText(t('common.resume'))).toBeTruthy();

    await user.click(screen.getByText(t('plugins.copyLogs')));
    await waitFor(() => expect(clipboard).toHaveBeenCalledTimes(1));
    expect(clipboard.mock.calls[0][0]).toContain('request marked');

    const wrap = screen.getByText(t('plugins.wrapLines')).closest('label')!.querySelector('input')!;
    expect((wrap as HTMLInputElement).checked).toBe(true);
    await user.click(wrap);
    expect((wrap as HTMLInputElement).checked).toBe(false);

    await user.click(screen.getByText(t('common.clear')));
    await waitFor(() => expect(calls.some((call) => call.method === 'DELETE')).toBe(true));
    expect(screen.getByText(t('plugins.noLogs'))).toBeTruthy();
  });
});

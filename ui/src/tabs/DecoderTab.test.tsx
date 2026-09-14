/** Decoder tab: multiple payloads, chains, and the raw view. */
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DecoderTab } from './DecoderTab';
import { resetDecoderTabs } from './decoderStore';
import { renderWithI18n as render, t } from '../test-utils';

let lastChain: { value: string; steps: unknown[] } | null = null;
let chainResult: { codec: string; direction: string; value: string }[] = [];

beforeEach(() => {
  // Tabs outlive the component by design, so each test starts clean.
  resetDecoderTabs();
  lastChain = null;
  chainResult = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path.includes('/api/codecs')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ codecs: ['base64', 'url', 'hex'], hashes: ['md5'] }),
        } as Response;
      }
      if (path.includes('/api/decode')) {
        lastChain = JSON.parse(String(init?.body));
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ steps: chainResult }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({}),
      } as Response;
    }) as unknown as typeof fetch,
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const input = () => screen.getByLabelText(t('decoder.inputLabel')) as HTMLTextAreaElement;

describe('decoder tabs', () => {
  it('opens with a single empty tab', async () => {
    render(<DecoderTab />);
    expect(await screen.findByText(t('decoder.untitled'))).toBeTruthy();
  });

  it('keeps each tab’s input separate', async () => {
    // Burp loses the first payload when you paste a second; this must not.
    render(<DecoderTab />);
    await userEvent.type(input(), 'first');

    await userEvent.click(screen.getByLabelText(t('decoder.newTab')));
    expect(input().value).toBe('');
    await userEvent.type(input(), 'second');

    await userEvent.click(screen.getByRole('button', { name: 'first' }));
    expect(input().value).toBe('first');
  });

  it('keeps each tab’s chain separate', async () => {
    render(<DecoderTab />);
    await userEvent.click(await screen.findByText(t('decoder.addStep')));
    expect(screen.getByText(t('decoder.chainSteps', { count: '1' }))).toBeTruthy();

    await userEvent.click(screen.getByLabelText(t('decoder.newTab')));
    expect(screen.getByText(t('decoder.chainSteps', { count: '0' }))).toBeTruthy();
  });

  it('labels a tab by its payload until it is renamed', async () => {
    render(<DecoderTab />);
    await userEvent.type(input(), 'eyJhbGciOi');
    expect(await screen.findByRole('button', { name: 'eyJhbGciOi' })).toBeTruthy();

    await userEvent.type(screen.getByLabelText(t('decoder.tabName')), 'jwt');
    expect(await screen.findByRole('button', { name: 'jwt' })).toBeTruthy();
  });

  it('closes a tab', async () => {
    render(<DecoderTab />);
    await userEvent.type(input(), 'one');
    await userEvent.click(screen.getByLabelText(t('decoder.newTab')));
    await userEvent.type(input(), 'two');

    await userEvent.click(screen.getByLabelText(t('decoder.closeTab', { title: 'two' })));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'two' })).toBeNull());
    expect(input().value).toBe('one');
  });

  it('never leaves the tab empty', async () => {
    // Closing the last one should hand back a fresh tab, not a blank pane.
    render(<DecoderTab />);
    await userEvent.click(
      await screen.findByLabelText(t('decoder.closeTab', { title: t('decoder.untitled') })),
    );
    expect(await screen.findByText(t('decoder.untitled'))).toBeTruthy();
  });
});

describe('tabs outlive the view', () => {
  it('keeps payloads when the tab is unmounted and shown again', async () => {
    // Switching to Proxy and back unmounts this component. Holding tabs in
    // component state threw away every payload at that moment.
    const view = render(<DecoderTab />);
    await userEvent.type(input(), 'my-token');
    await userEvent.click(screen.getByLabelText(t('decoder.newTab')));
    expect(document.querySelectorAll('.decoder-tabs .subtab').length).toBe(2);

    view.unmount();
    render(<DecoderTab />);

    expect(await screen.findByRole('button', { name: 'my-token' })).toBeTruthy();
    expect(document.querySelectorAll('.decoder-tabs .subtab').length).toBe(2);
  });

  it('remembers which tab was selected', async () => {
    const view = render(<DecoderTab />);
    await userEvent.type(input(), 'first');
    await userEvent.click(screen.getByLabelText(t('decoder.newTab')));
    await userEvent.type(input(), 'second');

    view.unmount();
    render(<DecoderTab />);

    const field = (await screen.findByLabelText(
      t('decoder.inputLabel'),
    )) as HTMLTextAreaElement;
    expect(field.value).toBe('second');
  });
});

describe('decoder chain', () => {
  it('sends the active tab’s input and steps', async () => {
    render(<DecoderTab />);
    await userEvent.type(input(), 'aGk=');
    await userEvent.click(screen.getByText(t('decoder.addStep')));

    await waitFor(() => expect(lastChain).not.toBeNull());
    expect(lastChain!.value).toBe('aGk=');
    expect(lastChain!.steps).toEqual([{ codec: 'base64', direction: 'decode' }]);
  });

  it('surfaces a decode failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/api/decode')) {
          return {
            ok: false,
            status: 400,
            statusText: 'Bad Request',
            json: async () => ({ detail: 'invalid base64' }),
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ codecs: ['base64'], hashes: [] }),
        } as Response;
      }) as unknown as typeof fetch,
    );
    render(<DecoderTab />);
    await userEvent.click(await screen.findByText(t('decoder.addStep')));
    expect(await screen.findByText(/invalid base64|400/)).toBeTruthy();
  });
});

describe('raw view', () => {
  it('shows the final value as plain text', async () => {
    chainResult = [{ codec: 'base64', direction: 'decode', value: 'hello world' }];
    render(<DecoderTab />);
    await userEvent.click(await screen.findByText(t('decoder.addStep')));

    await waitFor(() =>
      expect(document.querySelector('.decoder-raw')?.textContent).toBe('hello world'),
    );
  });

  it('shows the input itself when no steps are configured', async () => {
    render(<DecoderTab />);
    await userEvent.type(input(), 'untouched');
    await waitFor(() =>
      expect(document.querySelector('.decoder-raw')?.textContent).toBe('untouched'),
    );
  });

  it('switches to a hex dump', async () => {
    chainResult = [{ codec: 'base64', direction: 'decode', value: 'AB' }];
    render(<DecoderTab />);
    await userEvent.click(await screen.findByText(t('decoder.addStep')));
    await waitFor(() =>
      expect(document.querySelector('.decoder-raw')?.textContent).toBe('AB'),
    );

    await userEvent.click(screen.getByRole('button', { name: t('decoder.viewHex') }));
    expect(document.querySelector('.decoder-raw')?.textContent).toContain('41 42');
  });

  it('remembers the view per tab', async () => {
    // One payload can be JSON while the next is a binary blob, so the
    // choice belongs to the tab rather than the pane.
    chainResult = [{ codec: 'base64', direction: 'decode', value: 'AB' }];
    render(<DecoderTab />);
    await userEvent.click(await screen.findByText(t('decoder.addStep')));
    await userEvent.click(screen.getByRole('button', { name: t('decoder.viewHex') }));
    await waitFor(() =>
      expect(document.querySelector('.decoder-raw')?.textContent).toContain('41 42'),
    );

    await userEvent.click(screen.getByLabelText(t('decoder.newTab')));
    // A fresh tab starts on text, not on the previous tab's choice.
    expect(
      (screen.getByRole('button', { name: t('decoder.viewText') }) as HTMLElement)
        .className,
    ).toContain('active');
  });

  it('points at the hex view when the result is binary', async () => {
    chainResult = [
      { codec: 'hex', direction: 'decode', value: '\x00\x01\x02\x03\x04binary' },
    ];
    render(<DecoderTab />);
    await userEvent.click(await screen.findByText(t('decoder.addStep')));
    expect(await screen.findByText(t('decoder.binaryHint'))).toBeTruthy();
  });

  it('says nothing about binary for ordinary text', async () => {
    chainResult = [{ codec: 'base64', direction: 'decode', value: 'plain text' }];
    render(<DecoderTab />);
    await userEvent.click(await screen.findByText(t('decoder.addStep')));
    await waitFor(() =>
      expect(document.querySelector('.decoder-raw')?.textContent).toBe('plain text'),
    );
    expect(screen.queryByText(t('decoder.binaryHint'))).toBeNull();
  });
});

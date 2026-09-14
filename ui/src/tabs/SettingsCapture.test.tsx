/** System capture controls in the Settings tab. */
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsTab } from './SettingsTab';
import { renderWithI18n as render, t } from '../test-utils';

let captureSpec: string | null = null;
let posted: unknown[] = [];
let postFails = false;
let restartRequired = false;

const status = () => ({
  version: '0.1.0',
  proxy: { running: true, host: '127.0.0.1', port: 8080 },
  flows: 0,
  subscribers: 0,
  db_path: '/tmp/x.sqlite',
  intercept: {
    enabled: false,
    intercept_requests: true,
    intercept_responses: false,
    host_filter: null,
  },
  paused: 0,
  local_capture: {
    supported: true,
    approved: false,
    detail: 'activated waiting for user',
    spec: captureSpec,
  },
});

beforeEach(() => {
  captureSpec = null;
  posted = [];
  postFails = false;
  restartRequired = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (init?.method === 'POST' && path.includes('/api/capture/local')) {
        const body = JSON.parse(String(init.body));
        posted.push(body);
        if (postFails) {
          return {
            ok: false,
            status: 422,
            statusText: 'Unprocessable Entity',
            json: async () => ({ detail: 'bad spec' }),
          } as Response;
        }
        captureSpec = body.spec;
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            spec: body.spec,
            supported: true,
            approved: false,
            detail: 'activated waiting for user',
            restart_required: restartRequired,
          }),
        } as Response;
      }
      if (path.includes('/api/status')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => status(),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          confdir: '/tmp/mitm',
          available: { pem: true },
          install_url: 'http://mitm.it',
          proxy: '127.0.0.1:8080',
        }),
      } as Response;
    }) as unknown as typeof fetch,
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('system capture', () => {
  it('starts switched off', async () => {
    render(<SettingsTab />);
    const off = (await screen.findByLabelText(t('capture.off'))) as HTMLInputElement;
    expect(off.checked).toBe(true);
  });

  it('sends null to switch capture off, not an empty string', async () => {
    // '' means 'capture everything', so the two must not be conflated.
    captureSpec = 'curl';
    render(<SettingsTab />);
    await waitFor(() =>
      expect(
        (screen.getByLabelText(t('capture.filtered')) as HTMLInputElement).checked,
      ).toBe(true),
    );

    await userEvent.click(screen.getByLabelText(t('capture.off')));
    await waitFor(() => expect(posted).toEqual([{ spec: null }]));
  });

  it('sends an empty spec to capture every application', async () => {
    render(<SettingsTab />);
    await screen.findByLabelText(t('capture.all'));

    await userEvent.click(screen.getByLabelText(t('capture.all')));
    await waitFor(() => expect(posted).toEqual([{ spec: '' }]));
  });

  it('sends the filter when specific applications are chosen', async () => {
    render(<SettingsTab />);
    await userEvent.click(await screen.findByLabelText(t('capture.filtered')));

    // Choosing the mode must not apply an empty filter on its own.
    expect(posted).toEqual([]);

    await userEvent.type(
      screen.getByLabelText(t('capture.filterLabel')),
      'curl, !Slack',
    );
    await userEvent.click(screen.getByRole('button', { name: t('capture.apply') }));

    await waitFor(() => expect(posted).toEqual([{ spec: 'curl, !Slack' }]));
  });

  it('will not apply an empty filter', async () => {
    render(<SettingsTab />);
    await userEvent.click(await screen.findByLabelText(t('capture.filtered')));
    expect(
      (screen.getByRole('button', { name: t('capture.apply') }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('restores the saved filter', async () => {
    captureSpec = '!Slack';
    render(<SettingsTab />);
    await waitFor(() =>
      expect(
        (screen.getByLabelText(t('capture.filterLabel')) as HTMLInputElement).value,
      ).toBe('!Slack'),
    );
  });

  it('warns that the extension still needs approval', async () => {
    captureSpec = 'curl';
    render(<SettingsTab />);
    expect(await screen.findByText(t('dash.captureWaiting'))).toBeTruthy();
  });

  it('does not warn about approval while capture is off', async () => {
    render(<SettingsTab />);
    await screen.findByLabelText(t('capture.off'));
    expect(screen.queryByText(t('dash.captureWaiting'))).toBeNull();
  });

  it('surfaces a rejected spec instead of failing silently', async () => {
    postFails = true;
    render(<SettingsTab />);
    await userEvent.click(await screen.findByLabelText(t('capture.filtered')));
    await userEvent.type(screen.getByLabelText(t('capture.filterLabel')), 'x');
    await userEvent.click(screen.getByRole('button', { name: t('capture.apply') }));

    expect(await screen.findByText(/bad spec|422/)).toBeTruthy();
  });

  it('says a restart is needed when the change could not be applied live', async () => {
    // The OS redirector is a process-wide singleton, so switching specs on
    // a running engine does not always take effect. Saying 'done' would be
    // a lie.
    restartRequired = true;
    render(<SettingsTab />);
    await userEvent.click(await screen.findByLabelText(t('capture.all')));

    expect(await screen.findByText(t('capture.restartNeeded'))).toBeTruthy();
    expect(screen.queryByText(t('capture.applied'))).toBeNull();
  });

  it('says it is applied when the change took effect immediately', async () => {
    render(<SettingsTab />);
    await userEvent.click(await screen.findByLabelText(t('capture.all')));
    expect(await screen.findByText(t('capture.applied'))).toBeTruthy();
  });

  it('always states the pinning limitation', async () => {
    render(<SettingsTab />);
    expect(await screen.findByText(t('capture.pinningNote'))).toBeTruthy();
  });
});

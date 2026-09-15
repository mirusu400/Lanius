/** System capture controls in the Settings tab. */
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CaptureSection } from './settings/CaptureSection';
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
    render(<CaptureSection />);
    const off = (await screen.findByLabelText(t('capture.off'))) as HTMLInputElement;
    expect(off.checked).toBe(true);
  });

  it('sends null to switch capture off, not an empty string', async () => {
    // '' means 'capture everything', so the two must not be conflated.
    captureSpec = 'curl';
    render(<CaptureSection />);
    await waitFor(() =>
      expect(
        (screen.getByLabelText(t('capture.filtered')) as HTMLInputElement).checked,
      ).toBe(true),
    );

    await userEvent.click(screen.getByLabelText(t('capture.off')));
    await waitFor(() => expect(posted).toEqual([{ spec: null }]));
  });

  it('sends an empty spec to capture every application', async () => {
    render(<CaptureSection />);
    await screen.findByLabelText(t('capture.all'));

    await userEvent.click(screen.getByLabelText(t('capture.all')));
    await waitFor(() => expect(posted).toEqual([{ spec: '' }]));
  });

  it('sends the rules when specific applications are chosen', async () => {
    render(<CaptureSection />);
    await userEvent.click(await screen.findByLabelText(t('capture.filtered')));

    // Choosing the mode must not apply an empty list on its own.
    expect(posted).toEqual([]);

    await userEvent.click(screen.getByRole('button', { name: t('capture.addRule') }));
    await userEvent.type(
      screen.getByLabelText(t('capture.ruleValue', { index: '1' })),
      'curl',
    );
    await userEvent.click(screen.getByRole('button', { name: t('capture.apply') }));

    await waitFor(() => expect(posted).toEqual([{ spec: 'curl' }]));
  });

  it('builds one spec from several rules', async () => {
    render(<CaptureSection />);
    await userEvent.click(await screen.findByLabelText(t('capture.filtered')));

    await userEvent.click(screen.getByRole('button', { name: t('capture.addRule') }));
    await userEvent.type(
      screen.getByLabelText(t('capture.ruleValue', { index: '1' })),
      'chrome',
    );
    await userEvent.click(screen.getByRole('button', { name: t('capture.addRule') }));
    await userEvent.type(
      screen.getByLabelText(t('capture.ruleValue', { index: '2' })),
      'Slack',
    );
    await userEvent.selectOptions(
      screen.getByLabelText(t('capture.ruleAction', { index: '2' })),
      'exclude',
    );
    await userEvent.click(screen.getByRole('button', { name: t('capture.apply') }));

    await waitFor(() => expect(posted).toEqual([{ spec: 'chrome,!Slack' }]));
  });

  it('leaves a disabled rule out without deleting it', async () => {
    render(<CaptureSection />);
    await userEvent.click(await screen.findByLabelText(t('capture.filtered')));
    await userEvent.click(screen.getByRole('button', { name: t('capture.addRule') }));
    await userEvent.type(
      screen.getByLabelText(t('capture.ruleValue', { index: '1' })),
      'chrome',
    );
    await userEvent.click(screen.getByRole('button', { name: t('capture.addRule') }));
    await userEvent.type(
      screen.getByLabelText(t('capture.ruleValue', { index: '2' })),
      'firefox',
    );
    await userEvent.click(screen.getByLabelText(t('capture.toggleRule', { value: 'firefox' })));
    await userEvent.click(screen.getByRole('button', { name: t('capture.apply') }));

    await waitFor(() => expect(posted).toEqual([{ spec: 'chrome' }]));
    // Still listed, just not applied.
    expect(screen.getByLabelText(t('capture.ruleValue', { index: '2' }))).toBeTruthy();
  });

  it('refuses a rule with a comma rather than splitting it in two', async () => {
    // The comma is the spec separator, so 'a,b' would silently become two
    // rules. The engine refuses it too.
    render(<CaptureSection />);
    await userEvent.click(await screen.findByLabelText(t('capture.filtered')));
    await userEvent.click(screen.getByRole('button', { name: t('capture.addRule') }));
    await userEvent.type(
      screen.getByLabelText(t('capture.ruleValue', { index: '1' })),
      'chrome,firefox',
    );

    expect(screen.getByText(t('capture.ruleComma'))).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: t('capture.apply') }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(posted).toEqual([]);
  });

  it('removes a rule', async () => {
    render(<CaptureSection />);
    await userEvent.click(await screen.findByLabelText(t('capture.filtered')));
    await userEvent.click(screen.getByRole('button', { name: t('capture.addRule') }));
    await userEvent.type(
      screen.getByLabelText(t('capture.ruleValue', { index: '1' })),
      'chrome',
    );
    await userEvent.click(screen.getByLabelText(t('capture.removeRule', { value: 'chrome' })));

    expect(screen.queryByLabelText(t('capture.ruleValue', { index: '1' }))).toBeNull();
  });

  it('will not apply an empty filter', async () => {
    render(<CaptureSection />);
    await userEvent.click(await screen.findByLabelText(t('capture.filtered')));
    expect(
      (screen.getByRole('button', { name: t('capture.apply') }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('restores the saved rules', async () => {
    captureSpec = 'chrome,!Slack';
    render(<CaptureSection />);

    await waitFor(() =>
      expect(
        (screen.getByLabelText(t('capture.ruleValue', { index: '1' })) as HTMLInputElement)
          .value,
      ).toBe('chrome'),
    );
    expect(
      (screen.getByLabelText(t('capture.ruleValue', { index: '2' })) as HTMLInputElement)
        .value,
    ).toBe('Slack');
    expect(
      (screen.getByLabelText(t('capture.ruleAction', { index: '2' })) as HTMLSelectElement)
        .value,
    ).toBe('exclude');
  });

  it('warns that the extension still needs approval', async () => {
    captureSpec = 'curl';
    render(<CaptureSection />);
    expect(await screen.findByText(t('dash.captureWaiting'))).toBeTruthy();
  });

  it('does not warn about approval while capture is off', async () => {
    render(<CaptureSection />);
    await screen.findByLabelText(t('capture.off'));
    expect(screen.queryByText(t('dash.captureWaiting'))).toBeNull();
  });

  it('surfaces a rejected spec instead of failing silently', async () => {
    postFails = true;
    render(<CaptureSection />);
    await userEvent.click(await screen.findByLabelText(t('capture.filtered')));
    await userEvent.click(screen.getByRole('button', { name: t('capture.addRule') }));
    await userEvent.type(
      screen.getByLabelText(t('capture.ruleValue', { index: '1' })),
      'x',
    );
    await userEvent.click(screen.getByRole('button', { name: t('capture.apply') }));

    expect(await screen.findByText(/bad spec|422/)).toBeTruthy();
  });

  it('says a restart is needed when the change could not be applied live', async () => {
    // The OS redirector is a process-wide singleton, so switching specs on
    // a running engine does not always take effect. Saying 'done' would be
    // a lie.
    restartRequired = true;
    render(<CaptureSection />);
    await userEvent.click(await screen.findByLabelText(t('capture.all')));

    expect(await screen.findByText(t('capture.restartNeeded'))).toBeTruthy();
    expect(screen.queryByText(t('capture.applied'))).toBeNull();
  });

  it('says it is applied when the change took effect immediately', async () => {
    render(<CaptureSection />);
    await userEvent.click(await screen.findByLabelText(t('capture.all')));
    expect(await screen.findByText(t('capture.applied'))).toBeTruthy();
  });

  it('always states the pinning limitation', async () => {
    render(<CaptureSection />);
    expect(await screen.findByText(t('capture.pinningNote'))).toBeTruthy();
  });
});

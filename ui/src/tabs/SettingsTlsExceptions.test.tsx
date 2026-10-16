import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UpstreamError } from '../components/UpstreamError';
import { renderWithI18n as render, t } from '../test-utils';
import { TlsExceptionsSection } from './settings/TlsExceptionsSection';

let hosts: string[];
let puts: unknown[];
let reject: string | null;

beforeEach(() => {
  hosts = [];
  puts = [];
  reject = null;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toContain('/api/tls/exceptions');
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body));
      puts.push(body);
      if (reject) return { ok: false, status: 422, json: async () => ({ detail: reject }) } as Response;
      hosts = [...new Set((body.hosts as string[]).map((host) => host.toLowerCase()))].sort();
    }
    return { ok: true, status: 200, json: async () => ({ hosts }) } as Response;
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Upstream certificate exceptions', () => {
  it('adds and removes exact hosts', async () => {
    const user = userEvent.setup();
    render(<TlsExceptionsSection />);
    await screen.findByText(t('tlsExceptions.none'));

    await user.type(screen.getByLabelText(t('tlsExceptions.host')), 'Bad.Example.test');
    await user.click(screen.getByRole('button', { name: t('tlsExceptions.add') }));
    expect(await screen.findByText('bad.example.test')).toBeTruthy();
    expect(puts).toEqual([{ hosts: ['Bad.Example.test'] }]);

    await user.click(screen.getByRole('button', { name: t('tlsExceptions.removeHost', { host: 'bad.example.test' }) }));
    expect(await screen.findByText(t('tlsExceptions.none'))).toBeTruthy();
    expect(puts[1]).toEqual({ hosts: [] });
  });

  it('shows the engine refusing a wildcard', async () => {
    reject = "'*.example.test': wildcards are not allowed; name the exact host";
    const user = userEvent.setup();
    render(<TlsExceptionsSection />);
    await screen.findByText(t('tlsExceptions.none'));
    await user.type(screen.getByLabelText(t('tlsExceptions.host')), '*.example.test');
    await user.click(screen.getByRole('button', { name: t('tlsExceptions.add') }));
    expect((await screen.findByRole('alert')).textContent).toContain('wildcards are not allowed');
  });
});

describe('Upstream error in the request detail', () => {
  it('explains a rejected certificate and allows the host only after confirmation', async () => {
    const user = userEvent.setup();
    render(<UpstreamError error="Certificate verify failed: hostname mismatch" host="app.example.test" hasResponse={false} />);

    expect(screen.getByText(t('detail.tlsVerifyFailed'))).toBeTruthy();
    expect(screen.getByText('Certificate verify failed: hostname mismatch')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: t('detail.allowHost') }));
    expect(screen.getByText(t('detail.allowHostMessage', { host: 'app.example.test' }))).toBeTruthy();
    expect(puts).toEqual([]);

    await user.click(screen.getByRole('button', { name: t('detail.allowHostConfirm') }));
    await waitFor(() => expect(puts).toEqual([{ hosts: ['app.example.test'] }]));
    expect(await screen.findByText(t('detail.tlsExceptionAdded', { host: 'app.example.test' }))).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('detail.allowHost') })).toBeNull();
  });

  it('cancelling leaves verification on', async () => {
    const user = userEvent.setup();
    render(<UpstreamError error="Certificate verify failed: hostname mismatch" host="app.example.test" hasResponse={false} />);
    await user.click(screen.getByRole('button', { name: t('detail.allowHost') }));
    await user.click(screen.getByRole('button', { name: t('common.cancel') }));
    expect(puts).toEqual([]);
  });

  it('shows other upstream errors without offering an exception', () => {
    render(<UpstreamError error="Connection refused" host="app.example.test" hasResponse={false} />);
    expect(screen.getByText(t('detail.noResponse'))).toBeTruthy();
    expect(screen.getByText('Connection refused')).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('detail.allowHost') })).toBeNull();
  });

  it('renders nothing for a flow without an error', () => {
    const { container } = render(<UpstreamError error={null} host="app.example.test" hasResponse />);
    expect(container.textContent).toBe('');
  });
});

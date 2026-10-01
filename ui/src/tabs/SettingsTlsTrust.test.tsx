import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TlsTrustSection } from './settings/TlsTrustSection';
import { renderWithI18n as render, t } from '../test-utils';

const CERT = '-----BEGIN CERTIFICATE-----\npublic CA\n-----END CERTIFICATE-----';
const CA = { subject: 'CN=Private CA', expires_at: '2036-01-01T00:00:00+00:00', sha256: 'abcd', valid: true };
let posted: unknown[];
let fail: boolean;
let configured: boolean;

beforeEach(() => {
  posted = [];
  fail = false;
  configured = false;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body));
      posted.push(body);
      if (fail) return { ok: false, status: 422, json: async () => ({ detail: 'certificate is not a CA' }) } as Response;
      configured = Boolean(body.ca_pem);
    }
    return { ok: true, status: 200, json: async () => ({ certificates: configured ? [CA] : [] }) } as Response;
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Upstream CA trust', () => {
  it('applies pasted CA certificates and shows the saved identity', async () => {
    render(<TlsTrustSection />);
    await screen.findByText(t('tlsTrust.default'));
    await userEvent.type(screen.getByLabelText(t('tlsTrust.pem')), CERT);
    await userEvent.click(screen.getByRole('button', { name: t('tlsTrust.apply') }));
    expect(await screen.findByText(CA.subject)).toBeTruthy();
    expect(posted).toEqual([{ ca_pem: CERT }]);
    expect(screen.getByText('2036-01-01')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: t('tlsTrust.remove') }));
    expect(await screen.findByText(t('tlsTrust.removed'))).toBeTruthy();
    expect(posted[1]).toEqual({ ca_pem: '' });
  });

  it('reads a selected file but trusts it only after Apply', async () => {
    render(<TlsTrustSection />);
    await screen.findByText(t('tlsTrust.default'));
    const file = new File([CERT], 'vpn-ca.pem', { type: 'application/x-pem-file' });
    await userEvent.upload(screen.getByLabelText(t('tlsTrust.import')), file);
    await waitFor(() => expect((screen.getByLabelText(t('tlsTrust.pem')) as HTMLTextAreaElement).value).toBe(CERT));
    expect(posted).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: t('tlsTrust.apply') }));
    expect(await screen.findByText(t('tlsTrust.applied'))).toBeTruthy();
  });

  it('keeps the previous trust and input when the server refuses a certificate', async () => {
    configured = true;
    fail = true;
    render(<TlsTrustSection />);
    await screen.findByText(CA.subject);
    await userEvent.type(screen.getByLabelText(t('tlsTrust.pem')), 'bad certificate');
    await userEvent.click(screen.getByRole('button', { name: t('tlsTrust.apply') }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'certificate is not a CA');
    expect(screen.getByText(CA.subject)).toBeTruthy();
    expect((screen.getByLabelText(t('tlsTrust.pem')) as HTMLTextAreaElement).value).toBe('bad certificate');
  });
});

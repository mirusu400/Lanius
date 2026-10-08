import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { CaInfo } from '../api/client';
import { renderWithI18n as render, t } from '../test-utils';
import { DoctorPanel } from './DoctorPanel';

let trust: CaInfo['system_trust'];
let caAvailable: boolean;
let browserTrusted: boolean;

beforeEach(() => {
  caAvailable = true;
  browserTrusted = false;
  trust = { platform: 'Windows', status: 'trusted' };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    let data: unknown;
    if (url.endsWith('/api/ca')) data = {
      confdir: '/ca', available: { pem: caAvailable }, install_url: 'http://mitm.it',
      proxy: '127.0.0.1:8080', system_trust: trust,
    };
    else if (url.endsWith('/api/browser')) data = {
      available: true, name: 'Chrome', profile: '/browser', ca_trusted: browserTrusted,
    };
    else if (url.endsWith('/api/dashboard')) data = {
      flows: 0, modes: [], proxy: { running: true, host: '127.0.0.1', port: 8080 },
    };
    else throw new Error(`Unexpected external request: ${url}`);
    return { ok: true, status: 200, json: async () => data } as Response;
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function certificateRow() {
  render(<DoctorPanel />);
  const title = await screen.findByText(t('doctor.certificate'));
  return within(title.closest('.doctor-check') as HTMLElement);
}

it('accepts the current Windows trusted root even without browser SPKI support', async () => {
  const row = await certificateRow();
  expect(row.getByText(t('doctor.state.ok'))).toBeTruthy();
  expect(row.getByText(t('doctor.caWindowsTrusted'))).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('reports a missing Windows root even if the separate browser can use SPKI', async () => {
  trust = { platform: 'Windows', status: 'not_trusted' };
  browserTrusted = true;
  const row = await certificateRow();
  expect(row.getByText(t('doctor.state.warn'))).toBeTruthy();
  expect(row.getByText(t('doctor.caWindowsUntrusted'))).toBeTruthy();
});

it.each([undefined, { platform: 'Windows', status: 'unknown', detail: 'store denied' } as const])(
  'does not describe an unchecked client as having a certificate error: %j', async (value) => {
    trust = value;
    const row = await certificateRow();
    expect(row.getByText(t('doctor.state.unverified'))).toBeTruthy();
    expect(row.queryByText(t('doctor.state.warn'))).toBeNull();
    expect(row.queryByText(t('doctor.state.bad'))).toBeNull();
  },
);

it('does not let browser setup hide an invalid or expired CA', async () => {
  trust = { platform: 'Windows', status: 'invalid', detail: 'expired' };
  browserTrusted = true;
  const row = await certificateRow();
  expect(row.getByText(t('doctor.state.bad'))).toBeTruthy();
  expect(row.getByText(t('doctor.caInvalid', { message: 'expired' }))).toBeTruthy();
});

it('reports a missing CA file', async () => {
  caAvailable = false;
  const row = await certificateRow();
  expect(row.getByText(t('doctor.state.bad'))).toBeTruthy();
  expect(row.getByText(t('doctor.caMissing'))).toBeTruthy();
});

it('keeps separate browser readiness on platforms without system inspection', async () => {
  trust = { platform: 'Darwin', status: 'unsupported' };
  browserTrusted = true;
  const row = await certificateRow();
  expect(row.getByText(t('doctor.state.ok'))).toBeTruthy();
  expect(row.getByText(t('doctor.caReady'))).toBeTruthy();
});

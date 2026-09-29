import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Issue, ScannerState } from '../api/types';
import { renderWithI18n as render, t } from '../test-utils';
import { IssuesTab } from './IssuesTab';

const issue: Issue = {
  id: 'issue-1',
  fingerprint: 'f',
  plugin_id: 'checks',
  check_id: 'headers',
  scan_mode: 'passive',
  title: 'Missing security header',
  severity: 'medium',
  confidence: 'firm',
  status: 'open',
  detail: 'The response is missing X-Frame-Options.',
  remediation: 'Add the header.',
  url: 'https://example.test/path',
  host: 'example.test',
  path: '/path',
  parameter: 'x-frame-options',
  flow_id: 'flow-1',
  evidence: { status: 200 },
  first_seen: 1,
  last_seen: 2,
  occurrences: 3,
};

const scanner: ScannerState = {
  passive_enabled: true,
  passive_checks: [{
    id: 'checks.headers', plugin: 'checks', title: 'Headers', description: null, mode: 'passive',
  }],
  active_checks: [{
    id: 'checks.probe', plugin: 'checks', title: 'Probe', description: 'Active probe', mode: 'active',
  }],
  jobs: [],
};

let calls: Array<{ url: string; init?: RequestInit }> = [];

function response(body: unknown) {
  return { ok: true, json: async () => body } as Response;
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('/api/issues?')) {
      return response({
        items: [issue],
        count: 1,
        summary: {
          total: 1,
          by_severity: { info: 0, low: 0, medium: 1, high: 0, critical: 0 },
          by_status: { open: 1, resolved: 0, false_positive: 0 },
        },
      });
    }
    if (url.endsWith('/api/scanner')) return response(scanner);
    if (url.endsWith('/api/issues/issue-1')) return response({ ...issue, status: 'resolved' });
    if (url.includes('/api/scanner/active/flow-1')) {
      return response({ id: 'job-1', status: 'pending' });
    }
    return response({});
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('IssuesTab', () => {
  it('shows findings, evidence, and changes status', async () => {
    const user = userEvent.setup();
    render(<IssuesTab />);
    expect((await screen.findAllByText('Missing security header')).length).toBe(2);
    expect(screen.getByText('The response is missing X-Frame-Options.')).toBeTruthy();
    expect(screen.getByText(/"status": 200/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: t('issues.resolved') }));
    await waitFor(() => expect(calls.some(({ url, init }) =>
      url.endsWith('/api/issues/issue-1') && init?.method === 'PATCH',
    )).toBe(true));
  });

  it('starts selected active checks for a flow', async () => {
    const user = userEvent.setup();
    render(<IssuesTab />);
    await user.type(await screen.findByLabelText(t('issues.flowId')), 'flow-1');
    await user.click(screen.getByText('Probe'));
    await user.click(screen.getByText(t('issues.startActive')));

    await waitFor(() => expect(calls.some(({ url }) =>
      url.includes('/api/scanner/active/flow-1'),
    )).toBe(true));
    const call = calls.find(({ url }) => url.includes('/api/scanner/active/flow-1'))!;
    expect(JSON.parse(String(call.init?.body)).check_ids).toEqual(['checks.probe']);
  });
});

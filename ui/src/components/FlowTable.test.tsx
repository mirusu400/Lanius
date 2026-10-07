import { act, cleanup, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';

import { renderWithI18n as render, t } from '../test-utils';
import { setShowLocalSourceIpColumn } from '../historySourceColumn';
import type { FlowSummary } from '../api/types';
import { FlowTable } from './FlowTable';

const flow: FlowSummary = {
  id: 'one', type: 'http', client_addr: null, server_addr: null,
  local_source_ip: '192.0.2.12',
  scheme: 'https', method: 'GET', host: 'example.test', port: 443,
  path: '/', query: null, http_version: 'HTTP/1.1', request_size: 0,
  started_at: 1, status_code: 200, reason: 'OK', response_size: 0,
  response_mime: null, completed_at: 2, duration_ms: 1, error: null,
  source: 'proxy', comment: null,
};

afterEach(() => {
  cleanup();
  setShowLocalSourceIpColumn(false);
});

it('shows the saved local source IP only when enabled in settings', () => {
  setShowLocalSourceIpColumn(false);
  render(<FlowTable flows={[flow]} selectedId={null} onSelect={() => undefined} />);
  expect(screen.queryByText(t('flow.localSourceIp'))).toBeNull();
  expect(screen.queryByText('192.0.2.12')).toBeNull();

  act(() => setShowLocalSourceIpColumn(true));
  expect(screen.getByText(t('flow.localSourceIp'))).toBeTruthy();
  expect(screen.getByText('192.0.2.12').getAttribute('title'))
    .toBe(t('flow.localSourceIpHint'));
});

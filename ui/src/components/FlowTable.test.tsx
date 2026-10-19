import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import { renderWithI18n as render, t } from '../test-utils';
import { setShowLocalSourceIpColumn } from '../historySourceColumn';
import type { FlowSummary } from '../api/types';
import { FlowTable } from './FlowTable';

const flow: FlowSummary = {
  id: 'one', request_number: 17, type: 'http', client_addr: null, server_addr: null,
  local_source_ip: '192.0.2.12',
  scheme: 'https', method: 'GET', host: 'example.test', port: 443,
  path: '/', query: null, http_version: 'HTTP/1.1', request_size: 0,
  started_at: 1, status_code: 200, reason: 'OK', response_size: 0,
  response_mime: null, completed_at: 2, duration_ms: 1, error: null,
  source: 'proxy', comment: null,
};

it('shows the stable request number in the first column', () => {
  render(<FlowTable flows={[flow]} selectedId={null} onSelect={() => undefined} />);
  const row = screen.getByText('example.test').closest('tr')!;
  expect(row.cells[0].textContent).toBe('17');
  expect(row.cells[1].querySelector('.history-bookmark')).toBeTruthy();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
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

it('reorders headers and their cells by drag and drop and remembers the order', async () => {
  const first = render(<FlowTable flows={[flow]} selectedId={null} onSelect={() => undefined} />);
  const host = screen.getByText(t('flow.host')).closest('th')!;
  const method = screen.getByText(t('flow.method')).closest('th')!;
  const transfer = { effectAllowed: 'none', dropEffect: 'none', setData: vi.fn() };

  fireEvent.dragStart(host, { dataTransfer: transfer });
  fireEvent.dragOver(method, { dataTransfer: transfer, clientX: 0 });
  fireEvent.drop(method, { dataTransfer: transfer, clientX: 0 });

  const labels = Array.from(document.querySelectorAll('.flow-table th'))
    .map((cell) => cell.textContent);
  expect(labels.indexOf(t('flow.host'))).toBeLessThan(labels.indexOf(t('flow.method')));
  const row = screen.getByText('example.test').closest('tr')!;
  expect(row.cells[3].textContent).toBe('example.test');
  expect(row.cells[4].textContent).toBe('GET');
  await waitFor(() => expect(JSON.parse(window.localStorage.getItem('lanius.columns.history.layout') ?? '{}').order)
    .toEqual([0, 1, 2, 4, 3, 5, 6, 7, 8, 9]));

  first.unmount();
  render(<FlowTable flows={[flow]} selectedId={null} onSelect={() => undefined} />);
  const restored = Array.from(document.querySelectorAll('.flow-table th'))
    .map((cell) => cell.textContent);
  expect(restored.indexOf(t('flow.host'))).toBeLessThan(restored.indexOf(t('flow.method')));
});

it('hides and restores columns from the header context menu', async () => {
  const user = userEvent.setup();
  render(<FlowTable flows={[flow]} selectedId={null} onSelect={() => undefined} />);
  const host = screen.getByText(t('flow.host')).closest('th')!;

  fireEvent.contextMenu(host, { clientX: 10, clientY: 10 });
  const hideHost = screen.getByRole('menuitemcheckbox', { name: t('flow.host') });
  expect(hideHost.getAttribute('aria-checked')).toBe('true');
  await user.click(hideHost);

  expect(screen.queryByText(t('flow.host'))).toBeNull();
  expect(screen.queryByText('example.test')).toBeNull();
  const method = screen.getByText(t('flow.method')).closest('th')!;
  fireEvent.contextMenu(method, { clientX: 10, clientY: 10 });
  const showHost = screen.getByRole('menuitemcheckbox', { name: t('flow.host') });
  expect(showHost.getAttribute('aria-checked')).toBe('false');
  await user.click(showHost);

  expect(screen.getByText(t('flow.host'))).toBeTruthy();
  expect(screen.getByText('example.test')).toBeTruthy();
});

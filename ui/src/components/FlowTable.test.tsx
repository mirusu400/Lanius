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
  const onSort = vi.fn();
  const first = render(<FlowTable flows={[flow]} selectedId={null} onSelect={() => undefined} onSort={onSort} />);
  const host = screen.getByRole('button', { name: t('flow.host') });
  const method = screen.getByText(t('flow.method')).closest('th')!;
  mockHeaderBounds();

  fireEvent.pointerDown(host, { button: 0, pointerId: 1, clientX: 450, clientY: 15 });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 310, clientY: 15 });
  expect(method.classList.contains('column-drop-before')).toBe(true);
  fireEvent.pointerUp(window, { pointerId: 1, clientX: 310, clientY: 15 });
  // Browsers may dispatch a click after pointerup. Dragging must not sort.
  fireEvent.click(host, { detail: 1 });
  expect(onSort).not.toHaveBeenCalled();
  expect(document.body.style.userSelect).toBe('');

  const labels = Array.from(document.querySelectorAll('.flow-table th'))
    .map((cell) => cell.textContent);
  expect(labels.indexOf(t('flow.host'))).toBeLessThan(labels.indexOf(t('flow.method')));
  const row = screen.getByText('example.test').closest('tr')!;
  expect(row.cells[3].textContent).toBe('example.test');
  expect(row.cells[4].textContent).toBe('GET');
  const widths = document.querySelectorAll('.flow-table col');
  expect((widths[3] as HTMLElement).style.width).toBe('180px');
  expect((widths[4] as HTMLElement).style.width).toBe('70px');
  await waitFor(() => expect(JSON.parse(window.localStorage.getItem('lanius.columns.history.layout') ?? '{}').order)
    .toEqual([0, 1, 2, 4, 3, 5, 6, 7, 8, 9, 10]));

  first.unmount();
  render(<FlowTable flows={[flow]} selectedId={null} onSelect={() => undefined} />);
  const restored = Array.from(document.querySelectorAll('.flow-table th'))
    .map((cell) => cell.textContent);
  expect(restored.indexOf(t('flow.host'))).toBeLessThan(restored.indexOf(t('flow.method')));
});

function mockHeaderBounds() {
  document.querySelectorAll('.flow-table th[data-column-index]').forEach((header, position) => {
    vi.spyOn(header, 'getBoundingClientRect').mockReturnValue({
      left: position * 100, right: (position + 1) * 100, width: 100,
      top: 0, bottom: 30, height: 30, x: position * 100, y: 0, toJSON: () => ({}),
    });
  });
}

it('moves a header after its target and keeps ordinary clicks sortable', async () => {
  const onSort = vi.fn();
  const user = userEvent.setup();
  render(<FlowTable flows={[flow]} selectedId={null} onSelect={() => undefined} onSort={onSort} />);
  mockHeaderBounds();
  const number = screen.getByRole('button', { name: '#' });
  fireEvent.pointerDown(number, { button: 0, pointerId: 1, clientX: 50, clientY: 15 });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 590, clientY: 15 });
  fireEvent.pointerUp(window, { pointerId: 1, clientX: 590, clientY: 15 });
  fireEvent.click(number, { detail: 1 });
  expect(onSort).not.toHaveBeenCalled();
  const row = screen.getByText('example.test').closest('tr')!;
  expect(row.cells[4].textContent).toBe('/');
  expect(row.cells[5].textContent).toBe('17');
  await user.click(number);
  expect(onSort).toHaveBeenCalledExactlyOnceWith('request_number');
});

it('sorts on a click with small pointer movement', () => {
  const onSort = vi.fn();
  render(<FlowTable flows={[flow]} selectedId={null} onSelect={() => undefined} onSort={onSort} />);
  mockHeaderBounds();
  const number = screen.getByRole('button', { name: '#' });
  fireEvent.pointerDown(number, { button: 0, pointerId: 1, clientX: 50, clientY: 15 });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 52, clientY: 16 });
  fireEvent.pointerUp(window, { pointerId: 1, clientX: 52, clientY: 16 });
  fireEvent.click(number, { detail: 1 });
  expect(onSort).toHaveBeenCalledExactlyOnceWith('request_number');
  expect(window.localStorage.getItem('lanius.columns.history.layout')).toBeNull();
});

it.each(['pointercancel', 'Escape', 'outside', 'blur'])('cancels header reordering on %s', (cancel) => {
  render(<FlowTable flows={[flow]} selectedId={null} onSelect={() => undefined} />);
  mockHeaderBounds();
  const host = screen.getByText(t('flow.host'));
  fireEvent.pointerDown(host, { button: 0, pointerId: 1, clientX: 450, clientY: 15 });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 310, clientY: 15 });
  if (cancel === 'pointercancel') fireEvent.pointerCancel(window, { pointerId: 1 });
  if (cancel === 'Escape') fireEvent.keyDown(window, { key: 'Escape' });
  if (cancel === 'blur') fireEvent.blur(window);
  if (cancel === 'outside') fireEvent.pointerMove(window, { pointerId: 1, clientX: 310, clientY: 100 });
  fireEvent.pointerUp(window, { pointerId: 1, clientX: 310, clientY: 100 });
  expect(screen.getByText('example.test').closest('tr')!.cells[4].textContent).toBe('example.test');
  expect(window.localStorage.getItem('lanius.columns.history.layout')).toBeNull();
  expect(document.body.style.userSelect).toBe('');
});

it('resizes a column without reordering or sorting it', () => {
  const onSort = vi.fn();
  render(<FlowTable flows={[flow]} selectedId={null} onSelect={() => undefined} onSort={onSort} />);
  mockHeaderBounds();
  const host = screen.getByRole('button', { name: t('flow.host') }).closest('th')!;
  const handle = host.querySelector<HTMLElement>('.column-resize-handle')!;
  handle.setPointerCapture = vi.fn();
  fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 490, clientY: 15 });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 520, clientY: 15 });
  fireEvent.pointerUp(window, { pointerId: 1 });
  expect(handle.getAttribute('aria-valuenow')).toBe('210');
  expect(window.localStorage.getItem('lanius.columns.history.layout')).toBeNull();
  expect(onSort).not.toHaveBeenCalled();
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

it('names the listener the proxy actually uses when nothing is captured', () => {
  render(<FlowTable flows={[]} selectedId={null} onSelect={() => undefined} proxyAddress="127.0.0.1:8083" />);
  expect(screen.getByText(t('proxy.emptyTable', { proxy: '127.0.0.1:8083' }))).toBeTruthy();
  expect(screen.queryByText(/8080/)).toBeNull();
});

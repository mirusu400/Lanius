import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { renderWithI18n as render, t } from '../test-utils';
import { setShowLocalSourceIpColumn } from '../historySourceColumn';
import type { FlowSummary } from '../api/types';
import { FlowTable } from './FlowTable';

const flow = {
  id: 'one', type: 'http', host: 'example.test', method: 'GET', path: '/',
  started_at: 1, server_addr: '203.0.113.1:443',
} as FlowSummary;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, json: async () => ({ one: '8.8.8.8' }),
  })));
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  setShowLocalSourceIpColumn(false);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function togglePublicIp() {
  fireEvent.contextMenu(screen.getByText(t('flow.host')).closest('th')!, { clientX: 10, clientY: 10 });
  const item = screen.getByRole('menuitemcheckbox', { name: t('flow.publicIpEstimate') });
  const checked = item.getAttribute('aria-checked');
  await userEvent.click(item);
  return checked;
}

it('defaults to hidden, displays saved estimates via the header menu, and remembers visibility', async () => {
  const first = render(<FlowTable flows={[flow]} selectedId={null} onSelect={() => undefined} />);
  expect(screen.queryByText(t('flow.publicIpEstimate'))).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
  expect(await togglePublicIp()).toBe('false');
  expect(await screen.findByText('8.8.8.8')).toBeTruthy();
  expect(screen.getByText('8.8.8.8').getAttribute('title')).toBe(t('flow.publicIpEstimateHint'));
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/api/egress-ip/estimates'), expect.objectContaining({
    method: 'POST', body: JSON.stringify({ flow_ids: ['one'] }),
  }));
  first.unmount();
  render(<FlowTable flows={[flow]} selectedId={null} onSelect={() => undefined} />);
  expect(await screen.findByText('8.8.8.8')).toBeTruthy();
  expect(await togglePublicIp()).toBe('true');
  expect(screen.queryByText('8.8.8.8')).toBeNull();
});

it('adds the hidden column to existing layouts while preserving their order, hidden columns and widths', async () => {
  window.localStorage.setItem('lanius.columns.history', JSON.stringify([95, 48, 84, 70, 180, 260, 66, 82, 78, 84]));
  window.localStorage.setItem('lanius.columns.history.layout', JSON.stringify({
    order: [4, 0, 1, 2, 3, 5, 6, 7, 8, 9], hidden: [3],
  }));
  render(<FlowTable flows={[flow]} selectedId={null} onSelect={() => undefined} />);
  expect(screen.queryByText(t('flow.publicIpEstimate'))).toBeNull();
  expect(screen.queryByText(t('flow.method'))).toBeNull();
  expect(document.querySelector('.flow-table th')?.textContent).toBe(t('flow.host'));
  expect((document.querySelectorAll('.flow-table col')[1] as HTMLElement).style.width).toBe('95px');
  await togglePublicIp();
  expect(await screen.findByText('8.8.8.8')).toBeTruthy();
});

it('can display public and local IP columns together and leaves unknown estimates empty', async () => {
  setShowLocalSourceIpColumn(true);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ one: null }) })));
  render(<FlowTable flows={[{ ...flow, local_source_ip: '192.0.2.12' }]} selectedId={null} onSelect={() => undefined} />);
  await togglePublicIp();
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  const row = screen.getByText('example.test').closest('tr')!;
  expect(row.cells[10].textContent).toBe('192.0.2.12');
  expect(row.cells[11].textContent).toBe('—');
});

it('refreshes live rows without a reload and stops polling when hidden', async () => {
  vi.useFakeTimers();
  window.localStorage.setItem('lanius.columns.history.layout', JSON.stringify({
    order: Array.from({ length: 11 }, (_, i) => i), hidden: [],
  }));
  const view = render(<FlowTable flows={[flow]} selectedId={null} onSelect={() => undefined} />);
  await act(async () => {});
  expect(screen.getByText('8.8.8.8')).toBeTruthy();
  vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ one: '8.8.8.8', two: '1.1.1.1' }) } as Response);
  view.rerender(<FlowTable flows={[{ ...flow, id: 'two', host: 'second.test' }, flow]} selectedId={null} onSelect={() => undefined} />);
  expect(screen.getByText('8.8.8.8')).toBeTruthy();
  await act(() => vi.advanceTimersByTimeAsync(2000));
  expect(screen.getByText('1.1.1.1')).toBeTruthy();
  fireEvent.contextMenu(screen.getByText(t('flow.host')).closest('th')!, { clientX: 10, clientY: 10 });
  fireEvent.click(screen.getByRole('menuitemcheckbox', { name: t('flow.publicIpEstimate') }));
  const calls = vi.mocked(fetch).mock.calls.length;
  await act(() => vi.advanceTimersByTimeAsync(4000));
  expect(fetch).toHaveBeenCalledTimes(calls);
});

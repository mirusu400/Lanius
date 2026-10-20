import { act, cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { RunSummary } from '../api/types';
import { renderWithI18n as render, t } from '../test-utils';
import { TOAST_PREFERENCES_KEY } from '../toastPreferences';
import { useFuzzerCompletionToast } from './useFuzzerCompletionToast';
import { useToast } from './Toast';

let notify: ReturnType<typeof useFuzzerCompletionToast>;
let dismiss: () => void;
function Workspace({ tab }: { tab: string }) {
  notify = useFuzzerCompletionToast();
  dismiss = useToast().dismissToast;
  return <div>{tab}</div>;
}
const run: RunSummary = { id: 'run-1', mode: 'single_position', url: 'https://test/', status: 'completed',
  completed: 5, total: 5, started_at: 1000, finished_at: 1001, error: null };
beforeEach(() => localStorage.clear());
afterEach(cleanup);

it('announces completion once while another workspace tab is active', () => {
  const { rerender } = render(<Workspace tab="Fuzzer" />);
  rerender(<Workspace tab="Proxy" />);
  act(() => notify(run));
  expect(screen.getByText('Proxy')).toBeTruthy();
  expect(screen.getByText(t('toast.fuzzerCompleted', { completed: 5, total: 5 }))).toBeTruthy();
  act(() => { dismiss(); notify(run); });
  expect(screen.queryByRole('status')).toBeNull();
});

it('distinguishes stopped and failed runs and never hides failures with preferences', () => {
  localStorage.setItem(TOAST_PREFERENCES_KEY, JSON.stringify({ fuzzerRun: false }));
  render(<Workspace tab="Replay" />);
  act(() => {
    notify({ ...run, status: 'stopped' });
    notify({ ...run, id: 'running', status: 'running' });
    notify({ ...run, id: 'failed', status: 'failed', completed: 2, error: 'Connection refused' });
  });
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByRole('alert').textContent).toContain(t('toast.fuzzerFailed', { completed: 2, total: 5 }));
  expect(screen.getByRole('alert').textContent).toContain('Connection refused');
});

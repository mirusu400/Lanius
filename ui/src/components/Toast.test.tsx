import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderWithI18n as render, t } from '../test-utils';
import { notifyRequestTransferred } from '../requestTransfers';
import { defaultToastPreferences, loadToastPreferences, TOAST_PREFERENCES_KEY } from '../toastPreferences';
import { Dialog } from './Dialog';
import { useToast } from './Toast';
import { engineRequestFailed } from '../engineConnection';
import { notifyClipboardError, notifyClipboardSuccess } from '../clipboard';

let feedback: ReturnType<typeof useToast>;
function Probe() {
  feedback = useToast();
  return null;
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('merges repeated notifications and expires them independently', () => {
  vi.useFakeTimers();
  render(<Probe />);
  act(() => feedback.showToast({ message: 'saved', category: 'settings', durationMs: 3000 }));
  act(() => vi.advanceTimersByTime(2000));
  act(() => feedback.showToast({ message: 'saved', category: 'settings', durationMs: 3000 }));
  act(() => feedback.showToast({ message: 'blocked', tone: 'error', durationMs: 6000 }));
  expect(screen.getAllByText('saved')).toHaveLength(1);
  act(() => vi.advanceTimersByTime(3000));
  expect(screen.getByText('saved').closest('.app-toast')?.classList.contains('exiting')).toBe(true);
  act(() => vi.advanceTimersByTime(240));
  expect(screen.queryByText('saved')).toBeNull();
  expect(screen.getByRole('alert').textContent).toBe('blocked');
  act(() => vi.advanceTimersByTime(3000));
  expect(screen.getByRole('alert').classList.contains('exiting')).toBe(true);
  act(() => vi.advanceTimersByTime(240));
  expect(screen.queryByRole('alert')).toBeNull();
});

it('keeps default notifications visible long enough to notice', () => {
  vi.useFakeTimers();
  render(<Probe />);
  act(() => feedback.showToast({ message: 'copied', tone: 'success' }));
  act(() => vi.advanceTimersByTime(4499));
  expect(screen.getByRole('status').classList.contains('exiting')).toBe(false);
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByRole('status').classList.contains('exiting')).toBe(true);
});

it('bounds the stack without displacing errors with success notifications', () => {
  render(<Probe />);
  act(() => {
    feedback.showToast({ message: 'blocked', tone: 'error' });
    for (let i = 0; i < 5; i++) feedback.showToast({ message: `success ${i}` });
  });
  expect(document.querySelectorAll('.app-toast')).toHaveLength(3);
  expect(screen.getByRole('alert').textContent).toBe('blocked');
  expect(screen.queryByText('success 0')).toBeNull();
  act(() => {
    feedback.showToast({ message: 'error 2', tone: 'error' });
    feedback.showToast({ message: 'error 3', tone: 'error' });
    feedback.showToast({ message: 'ignored success' });
  });
  expect(screen.getAllByRole('alert')).toHaveLength(3);
  expect(screen.queryByText('ignored success')).toBeNull();
});

it('dismisses the whole stack, including persistent notifications', () => {
  vi.useFakeTimers();
  render(<Probe />);
  act(() => feedback.showToast({ message: 'persistent', durationMs: 0 }));
  act(() => vi.advanceTimersByTime(60_000));
  expect(screen.getByText('persistent')).toBeTruthy();
  act(() => {
    feedback.showToast({ message: 'temporary' });
    feedback.dismissToast();
  });
  act(() => vi.advanceTimersByTime(6000));
  expect(document.querySelector('.app-toasts')).toBeNull();
});

it('filters transfer categories independently while always allowing errors', () => {
  localStorage.setItem(TOAST_PREFERENCES_KEY, JSON.stringify({ replay: false }));
  render(<Probe />);
  act(() => {
    notifyRequestTransferred('Replay');
    notifyRequestTransferred('Fuzzer');
  });
  expect(screen.queryByText(t('toast.requestTransferred', { tool: 'Replay' }))).toBeNull();
  expect(screen.getByText(t('toast.requestTransferred', { tool: 'Fuzzer' }))).toBeTruthy();
  act(() => feedback.showToast({ message: 'Lockdown blocked', category: 'replay', tone: 'error' }));
  expect(screen.getByRole('alert').textContent).toBe('Lockdown blocked');
});

it('shows clipboard feedback through the existing toast provider', () => {
  render(<Probe />);
  act(() => notifyClipboardSuccess('URL copied', 'copy-url'));
  expect(screen.getByRole('status').textContent).toBe('URL copied');
  act(() => notifyClipboardError(new Error('permission denied')));
  expect(screen.getByRole('alert').textContent).toBe(
    t('clipboard.failed', { message: 'permission denied' }),
  );
});

it('does not repeat the active engine transport failure as a toast', () => {
  render(<div className="app"><Probe /></div>);
  act(() => { engineRequestFailed(new Error('Failed to fetch')); });
  act(() => feedback.showToast({ message: 'Could not load: Failed to fetch', tone: 'error' }));
  expect(screen.queryByRole('alert')).toBeNull();

  act(() => feedback.showToast({ message: 'A different action failed', tone: 'error' }));
  expect(screen.getByRole('alert').textContent).toBe('A different action failed');
});

it('applies preference changes immediately and follows changes from another window', () => {
  render(<Probe />);
  act(() => feedback.showToast({ message: 'search done', category: 'search' }));
  act(() => feedback.updatePreferences({ ...feedback.preferences, search: false }));
  expect(screen.queryByText('search done')).toBeNull();
  expect(loadToastPreferences().search).toBe(false);
  act(() => {
    localStorage.setItem(TOAST_PREFERENCES_KEY, JSON.stringify({ replay: false }));
    window.dispatchEvent(new StorageEvent('storage', { key: TOAST_PREFERENCES_KEY }));
  });
  expect(feedback.preferences.replay).toBe(false);
  expect(feedback.preferences.search).toBe(true);
  act(() => {
    localStorage.removeItem(TOAST_PREFERENCES_KEY);
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
  });
  expect(feedback.preferences).toEqual(defaultToastPreferences());
});

it('keeps defaults for corrupt, missing and incorrectly typed preferences', () => {
  localStorage.setItem(TOAST_PREFERENCES_KEY, '{broken');
  expect(loadToastPreferences()).toEqual(defaultToastPreferences());
  localStorage.setItem(TOAST_PREFERENCES_KEY, JSON.stringify({ replay: false, settings: 'false', search: null, unknown: false }));
  expect(loadToastPreferences()).toEqual({ ...defaultToastPreferences(), replay: false });
});

it('keeps notifications visible as a modal opens and closes without moving focus', async () => {
  const { rerender } = render(<><Probe /><Dialog open={false} title="modal" onClose={() => {}}><button>inside</button></Dialog></>);
  act(() => feedback.showToast({ message: 'visible' }));
  rerender(<><Probe /><Dialog open title="modal" onClose={() => {}}><button>inside</button></Dialog></>);
  const dialog = screen.getByRole('dialog');
  await waitFor(() => expect(dialog.contains(screen.getByText('visible'))).toBe(true));
  const button = screen.getByRole('button', { name: 'inside' });
  button.focus();
  act(() => feedback.showToast({ message: 'another' }));
  expect(document.activeElement).toBe(button);
  rerender(<><Probe /><Dialog open={false} title="modal" onClose={() => {}}><button>inside</button></Dialog></>);
  await waitFor(() => expect(screen.getByText('visible').closest('dialog')).toBeNull());
});

it('keeps native popovers inside the active modal for screen readers', async () => {
  const show = vi.fn();
  const hide = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'showPopover', { configurable: true, value: show });
  Object.defineProperty(HTMLElement.prototype, 'hidePopover', { configurable: true, value: hide });
  try {
    const { rerender } = render(<><Probe /><Dialog open={false} title="modal" onClose={() => {}}>content</Dialog></>);
    act(() => feedback.showToast({ message: 'above modal' }));
    expect(document.querySelector('.app-toasts')?.getAttribute('popover')).toBe('manual');
    expect(show).toHaveBeenCalledTimes(1);
    act(() => feedback.showToast({ message: 'second' }));
    expect(show).toHaveBeenCalledTimes(2);
    expect(hide).toHaveBeenCalledTimes(2);
    rerender(<><Probe /><Dialog open title="modal" onClose={() => {}}>content</Dialog></>);
    await waitFor(() => expect(screen.getByRole('dialog').contains(screen.getByText('above modal'))).toBe(true));
    expect(show.mock.calls.length).toBeGreaterThan(2);
    rerender(<><Probe /><Dialog open={false} title="modal" onClose={() => {}}>content</Dialog></>);
    await waitFor(() => expect(screen.getByText('above modal').closest('dialog')).toBeNull());
  } finally {
    delete (HTMLElement.prototype as Partial<HTMLElement>).showPopover;
    delete (HTMLElement.prototype as Partial<HTMLElement>).hidePopover;
  }
});

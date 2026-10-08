import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { renderWithI18n as render, t } from '../test-utils';
import { autosave } from '../tabs/autosave';
import { CLOSE_REQUESTED } from '../shutdown';
import { DesktopClose } from './DesktopClose';

const invoke = vi.fn(async (_command: string) => {});
let dispose: (() => void) | undefined;
let edit: (value: unknown) => void;
let finishSave: ((response: Response) => void) | undefined;
let delaySave = false;
let failSave = false;
const writes: unknown[] = [];

function response(body: unknown, status = 200) {
  return { ok: status === 200, status, json: async () => body } as Response;
}

beforeEach(() => {
  vi.useFakeTimers();
  invoke.mockClear();
  writes.length = 0;
  delaySave = false;
  failSave = false;
  finishSave = undefined;
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: { invoke },
  });
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== 'PUT') return response({ value: null });
    writes.push(JSON.parse(String(init.body)).value);
    if (delaySave) return new Promise<Response>((resolve) => { finishSave = resolve; });
    return failSave ? response({ detail: 'save failed' }, 500) : response({ ok: true });
  }));
  dispose = autosave('replay', (listener) => {
    edit = listener;
    listener({ draft: '' });
    return () => {};
  }, () => {});
});

afterEach(() => {
  cleanup();
  dispose?.();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

async function open() {
  render(<DesktopClose />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

async function requestClose() {
  fireEvent(window, new Event(CLOSE_REQUESTED));
  await act(async () => { await vi.advanceTimersByTimeAsync(50); });
}

it('shows closing progress and waits for the last edit before stopping the engine', async () => {
  await open();
  expect(invoke).toHaveBeenCalledWith('close_ready');
  delaySave = true;
  edit({ draft: 'last keystroke' });
  await requestClose();

  expect(screen.getByRole('dialog', { name: t('shutdown.closing') })).toBeTruthy();
  expect(screen.getByRole('status', { name: t('shutdown.closing') })).toBeTruthy();
  expect(screen.getByText(t('shutdown.saving'))).toBeTruthy();
  expect(writes).toEqual([{ draft: 'last keystroke' }]);
  expect(invoke).not.toHaveBeenCalledWith('finish_close');

  // Repeated native close / Quit requests cannot duplicate the final save.
  fireEvent(window, new Event(CLOSE_REQUESTED));
  await act(async () => { finishSave!(response({ ok: true })); });
  expect(invoke.mock.calls.filter(([command]) => command === 'finish_close')).toHaveLength(1);
  expect(writes).toHaveLength(1);
  expect(screen.getByText(t('shutdown.stopping'))).toBeTruthy();
});

it('keeps the window open on a save failure and retries the same draft', async () => {
  await open();
  failSave = true;
  edit({ draft: 'must survive' });
  await requestClose();
  expect(screen.getByRole('alert').textContent).toBe('save failed');
  expect(invoke).not.toHaveBeenCalledWith('finish_close');

  failSave = false;
  fireEvent.click(screen.getByRole('button', { name: t('shutdown.retry') }));
  await act(async () => { await vi.advanceTimersByTimeAsync(50); });
  expect(writes).toEqual([{ draft: 'must survive' }, { draft: 'must survive' }]);
  expect(invoke).toHaveBeenCalledWith('finish_close');
});

it('lets the user return to the project after a save failure', async () => {
  await open();
  failSave = true;
  edit({ draft: 'keep editing' });
  await requestClose();
  fireEvent.click(screen.getByRole('button', { name: t('common.cancel') }));
  await act(async () => {});
  expect(invoke).toHaveBeenCalledWith('cancel_close');
  expect(invoke).not.toHaveBeenCalledWith('finish_close');
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('does not close later if a timed-out save eventually finishes', async () => {
  await open();
  delaySave = true;
  edit({ draft: 'slow save' });
  await requestClose();
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(screen.getByRole('alert').textContent).toBe(t('shutdown.saveTimeout'));
  expect(invoke).not.toHaveBeenCalledWith('finish_close');

  await act(async () => { finishSave!(response({ ok: true })); });
  expect(invoke).not.toHaveBeenCalledWith('finish_close');
});

it('closes safely from the project picker when there are no pending edits', async () => {
  dispose?.();
  await open();
  await requestClose();
  expect(writes).toEqual([]);
  expect(invoke).toHaveBeenCalledWith('finish_close');
});

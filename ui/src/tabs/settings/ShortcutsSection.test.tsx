import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { fireShortcut, renderWithI18n as render, t } from '../../test-utils';
import { formatShortcut, getShortcut, resetShortcut, SHORTCUTS } from '../../shortcuts';
import { useShortcuts } from '../../useShortcut';
import { ShortcutsSection } from './ShortcutsSection';

const replay = vi.fn();
const fuzzer = vi.fn();

function Harness() {
  useShortcuts({ 'request.sendToReplay': replay, 'request.sendToFuzzer': fuzzer });
  return <ShortcutsSection />;
}

function row(label: string) {
  return within(screen.getByText(label).closest('.shortcut-row') as HTMLElement);
}

beforeEach(() => {
  SHORTCUTS.forEach(({ id }) => resetShortcut(id));
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  SHORTCUTS.forEach(({ id }) => resetShortcut(id));
});

it('lists both send actions with platform defaults and records a persistent custom binding', () => {
  const { unmount } = render(<Harness />);
  const sendReplay = row(t('menu.sendToReplay'));
  const sendFuzzer = row(t('menu.sendToFuzzer'));
  const original = getShortcut('request.sendToReplay')!;
  expect(sendReplay.getByRole('button', { name: formatShortcut(getShortcut('request.sendToReplay')) })).toBeTruthy();
  expect(sendFuzzer.getByRole('button', { name: formatShortcut(getShortcut('request.sendToFuzzer')) })).toBeTruthy();
  fireShortcut('request.sendToReplay');
  fireShortcut('request.sendToFuzzer');
  expect(replay).toHaveBeenCalledTimes(1);
  expect(fuzzer).toHaveBeenCalledTimes(1);

  fireEvent.click(sendReplay.getByRole('button', { name: formatShortcut(getShortcut('request.sendToReplay')) }));
  // Recording a binding must not send the request.
  fireShortcut('request.sendToReplay');
  expect(replay).toHaveBeenCalledTimes(1);
  fireEvent.click(sendReplay.getByRole('button', { name: formatShortcut(getShortcut('request.sendToReplay')) }));
  const custom = { code: 'KeyY', ctrl: true, alt: false, shift: true, meta: false };
  fireEvent.keyDown(window, { code: 'KeyY', ctrlKey: true, shiftKey: true });
  expect(getShortcut('request.sendToReplay')).toEqual(custom);
  expect(JSON.parse(localStorage.getItem('lanius.shortcuts.v1')!)['request.sendToReplay']).toEqual(custom);
  fireEvent.keyDown(window, { code: original.code, ctrlKey: original.ctrl, metaKey: original.meta });
  expect(replay).toHaveBeenCalledTimes(1);
  unmount();

  render(<Harness />);
  expect(row(t('menu.sendToReplay')).getByRole('button', { name: formatShortcut(custom) })).toBeTruthy();
  fireShortcut('request.sendToReplay');
  expect(replay).toHaveBeenCalledTimes(2);
});

it('disables and restores a send shortcut', () => {
  render(<Harness />);
  const original = getShortcut('request.sendToFuzzer')!;
  fireEvent.click(row(t('menu.sendToFuzzer')).getByRole('button', { name: t('shortcuts.clear') }));
  expect(getShortcut('request.sendToFuzzer')).toBeNull();
  fireEvent.keyDown(window, { code: original.code, ctrlKey: original.ctrl, metaKey: original.meta });
  expect(fuzzer).not.toHaveBeenCalled();
  fireEvent.click(row(t('menu.sendToFuzzer')).getByRole('button', { name: t('shortcuts.reset') }));
  expect(getShortcut('request.sendToFuzzer')).toEqual(original);
  fireShortcut('request.sendToFuzzer');
  expect(fuzzer).toHaveBeenCalledTimes(1);
});

it('rejects a conflicting send shortcut', () => {
  render(<Harness />);
  fireEvent.click(row(t('menu.sendToReplay')).getByRole('button', { name: formatShortcut(getShortcut('request.sendToReplay')) }));
  fireShortcut('request.sendToFuzzer');
  expect(screen.getByText(t('shortcuts.conflict', {
    shortcut: formatShortcut(getShortcut('request.sendToFuzzer')),
    action: t('menu.sendToFuzzer'),
  }))).toBeTruthy();
  expect(replay).not.toHaveBeenCalled();
  expect(fuzzer).not.toHaveBeenCalled();
});

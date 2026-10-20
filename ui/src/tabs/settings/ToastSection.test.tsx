import { act, cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderWithI18n as render, t } from '../../test-utils';
import { TOAST_CATEGORIES, TOAST_PREFERENCES_KEY } from '../../toastPreferences';
import { sendTextToReplay, resetTabs, getTabs } from '../replayStore';
import { SettingsTab } from '../SettingsTab';
import { ToastSection } from './ToastSection';
import { searchSettings } from './settingsCatalogue';

beforeEach(() => { localStorage.clear(); resetTabs(); });
afterEach(() => { cleanup(); resetTabs(); vi.restoreAllMocks(); });

it('lets users disable one notification, persists it and still performs the action', async () => {
  const user = userEvent.setup();
  const first = render(<ToastSection />);
  await user.click(screen.getByRole('checkbox', { name: t('toast.category.replay') }));
  expect(JSON.parse(localStorage.getItem(TOAST_PREFERENCES_KEY)!)).toMatchObject({ replay: false, fuzzerTransfer: true });
  act(() => { sendTextToReplay('https://test/', 'GET / HTTP/1.1', 'test'); });
  expect(getTabs()).toHaveLength(1);
  expect(screen.queryByText(t('toast.requestTransferred', { tool: 'Replay' }))).toBeNull();
  first.unmount();
  render(<ToastSection />);
  expect((screen.getByRole('checkbox', { name: t('toast.category.replay') }) as HTMLInputElement).checked).toBe(false);
  await user.click(screen.getByRole('button', { name: t('toast.reset') }));
  for (const category of TOAST_CATEGORIES) {
    expect((screen.getByRole('checkbox', { name: t(`toast.category.${category}`) }) as HTMLInputElement).checked).toBe(true);
  }
  act(() => { sendTextToReplay('https://test/', 'GET / HTTP/1.1', 'test'); });
  expect(screen.getByText(t('toast.requestTransferred', { tool: 'Replay' }))).toBeTruthy();
});

it('can silence settings confirmations including changes to the notification settings', async () => {
  render(<ToastSection />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('checkbox', { name: t('toast.category.settings') }));
  await user.click(screen.getByRole('checkbox', { name: t('toast.category.search') }));
  expect(screen.queryByRole('status')).toBeNull();
  await user.click(screen.getByRole('checkbox', { name: t('toast.category.settings') }));
  expect(screen.getByText(t('toast.settingsApplied', { section: t('toast.section') }))).toBeTruthy();
});

it('keeps the session usable and reports when preferences cannot be saved', async () => {
  render(<ToastSection />);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  await userEvent.click(screen.getByRole('checkbox', { name: t('toast.category.search') }));
  expect((screen.getByRole('checkbox', { name: t('toast.category.search') }) as HTMLInputElement).checked).toBe(false);
  expect(screen.getByText(t('toast.settingsSessionOnly', { section: t('toast.section') }))).toBeTruthy();
});

it('is available under Appearance and through bilingual settings search', () => {
  render(<SettingsTab openGroup="appearance" />);
  expect(screen.getByRole('region', { name: t('toast.section') })).toBeTruthy();
  expect(screen.getAllByRole('checkbox').length).toBeGreaterThanOrEqual(TOAST_CATEGORIES.length);
  expect(searchSettings('Toast')[0]).toMatchObject({ id: 'toasts', group: 'appearance' });
  expect(searchSettings('알림')[0]).toMatchObject({ id: 'toasts', group: 'appearance' });
});

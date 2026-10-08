import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { renderWithI18n as render, t } from '../../test-utils';
import { SettingsSearch } from './SettingsSearch';
import { searchSettings } from './settingsCatalogue';

afterEach(cleanup);

it('finds bilingual labels, option names and all words regardless of the current tab', () => {
  expect(searchSettings('프로젝트 미디어')[0]).toMatchObject({ id: 'media-storage', group: 'project' });
  expect(searchSettings('MEDIA').map((item) => item.id)).toEqual(['media-storage']);
  expect(searchSettings('저장한도').some((item) => item.id === 'media-storage')).toBe(true);
  expect(searchSettings('SOCKS5')[0].id).toBe('upstream');
  expect(searchSettings('글꼴')[0].id).toBe('appearance');
  expect(searchSettings('Interface language')[0].id).toBe('language');
  expect(searchSettings('definitely-no-setting')).toEqual([]);
  expect(searchSettings('   ')).toEqual([]);
});

it('shows a result path and selects a section with the keyboard', async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  render(<SettingsSearch onSelect={onSelect} />);
  const input = screen.getByRole('searchbox', { name: t('settings.search.label') });
  await user.type(input, 'media');
  const results = screen.getByRole('region', { name: t('settings.search.results') });
  const button = within(results).getByRole('button', { name: `${t('settings.group.project')} → ${t('captureStorage.section')}` });
  await user.keyboard('{ArrowDown}');
  expect(document.activeElement).toBe(button);
  await user.keyboard('{ArrowUp}');
  expect(document.activeElement).toBe(input);
  await user.keyboard('{Enter}');
  expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'media-storage', group: 'project' }));
  expect(input).toHaveProperty('value', '');
  expect(screen.queryByRole('region', { name: t('settings.search.results') })).toBeNull();
});

it('dismisses results, handles no matches and does not navigate while composing Korean', async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  render(<SettingsSearch onSelect={onSelect} />);
  const input = screen.getByRole('searchbox', { name: t('settings.search.label') });
  await user.type(input, '미디어');
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
  fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
  expect(onSelect).not.toHaveBeenCalled();
  await user.keyboard('{Escape}');
  expect(input).toHaveProperty('value', '미디어');
  expect(screen.queryByRole('region', { name: t('settings.search.results') })).toBeNull();
  await user.click(screen.getByRole('button', { name: t('settings.search.clear') }));
  await user.type(input, 'zzzz-no-match');
  expect(screen.getByText(t('settings.search.empty'))).toBeTruthy();
  await user.keyboard('{Enter}');
  expect(onSelect).not.toHaveBeenCalled();
});

it('keeps WebKit results through an input blur until the result click and dismisses outside clicks', () => {
  const onSelect = vi.fn();
  render(<SettingsSearch onSelect={onSelect} />);
  const input = screen.getByRole('searchbox', { name: t('settings.search.label') });
  fireEvent.change(input, { target: { value: 'media' } });
  const button = within(screen.getByRole('region', { name: t('settings.search.results') })).getByRole('button');
  fireEvent.pointerDown(button);
  fireEvent.blur(input, { relatedTarget: null });
  expect(screen.getByRole('region', { name: t('settings.search.results') })).toBeTruthy();
  fireEvent.click(button);
  expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'media-storage' }));
  fireEvent.change(input, { target: { value: 'media' } });
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('region', { name: t('settings.search.results') })).toBeNull();
});

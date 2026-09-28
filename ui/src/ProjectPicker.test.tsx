import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import { API_BASE, setApiBase } from './api/client';
import { ProjectPicker } from './ProjectPicker';
import { renderWithI18n as render, t } from './test-utils';

afterEach(() => {
  cleanup();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  setApiBase('http://127.0.0.1:12954');
});

it('lets a user change a busy API/MCP port before opening a project', async () => {
  const calls: string[] = [];
  const invoke = vi.fn(async (command: string, args?: { port: number }) => {
    calls.push(command);
    if (command === 'list_projects') return [];
    if (command === 'set_api_port') return { api_url: `http://127.0.0.1:${args!.port}` };
    if (command === 'start_temp_project') return {
      id: 'temp', name: 'Temporary project', temporary: true,
      dbPath: '/tmp/test.sqlite', lastOpened: 0,
    };
    throw new Error(`unexpected command: ${command}`);
  });
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: { invoke },
  });
  const onOpen = vi.fn();
  const user = userEvent.setup();
  render(<ProjectPicker onOpen={onOpen} />);

  const field = screen.getByLabelText(t('mcp.port'));
  expect((field as HTMLInputElement).value).toBe('12954');
  await user.clear(field);
  await user.type(field, '13002');
  await user.click(screen.getByRole('button', { name: t('mcp.applyPort') }));
  await waitFor(() => expect(API_BASE).toBe('http://127.0.0.1:13002'));
  await user.click(screen.getByRole('button', { name: t('startup.tempStart') }));
  await waitFor(() => expect(onOpen).toHaveBeenCalledOnce());
  expect(calls.indexOf('set_api_port')).toBeLessThan(calls.indexOf('start_temp_project'));
});

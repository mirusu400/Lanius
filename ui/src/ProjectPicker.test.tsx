import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

it('shows what the engine is doing while a project starts', async () => {
  let finish!: (project: unknown) => void;
  let progress: unknown = null;
  const invoke = vi.fn(async (command: string) => {
    if (command === 'list_projects') return [];
    if (command === 'get_global_lockdown') return { enabled: false, forced: false };
    if (command === 'start_temp_project') return new Promise((resolve) => { finish = resolve; });
    if (command === 'startup_progress') return progress;
    throw new Error(`unexpected command: ${command}`);
  });
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
  const onOpen = vi.fn();
  const user = userEvent.setup();
  render(<ProjectPicker onOpen={onOpen} />);

  await user.click(screen.getByRole('button', { name: t('startup.tempStart') }));
  expect(screen.getByRole('status', { name: t('startup.progress.launching') })).toBeTruthy();

  progress = { stage: 'migrating', version: 16, target: 16, elapsed_ms: 4200 };
  const migrating = t('startup.progress.migrating', { version: '16', target: '16' });
  expect(await screen.findByRole('status', { name: migrating })).toBeTruthy();
  expect(screen.getByText(t('startup.progress.elapsed', { seconds: '4' }))).toBeTruthy();
  expect(screen.getByText(t('startup.progress.migratingHelp'))).toBeTruthy();

  finish({ id: 'temp', name: 'Temporary project', temporary: true, dbPath: '/tmp/t.sqlite', lastOpened: 0 });
  await waitFor(() => expect(onOpen).toHaveBeenCalledOnce());
});

it('removes the progress overlay and shows the error when a project fails to start', async () => {
  const invoke = vi.fn(async (command: string) => {
    if (command === 'list_projects') return [];
    if (command === 'get_global_lockdown') return { enabled: false, forced: false };
    if (command === 'start_temp_project') throw 'engine stopped making progress during startup (stage: database)';
    if (command === 'startup_progress') return null;
    throw new Error(`unexpected command: ${command}`);
  });
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
  const user = userEvent.setup();
  render(<ProjectPicker onOpen={vi.fn()} />);

  await user.click(screen.getByRole('button', { name: t('startup.tempStart') }));
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent', 'engine stopped making progress during startup (stage: database)',
  );
  expect(screen.queryByRole('status', { name: t('startup.progress.launching') })).toBeNull();
});

describe('opening a project that needs a database upgrade', () => {
  const saved = { id: 'big', name: 'hanafn', temporary: false, dbPath: '/p/big/lanius.sqlite', lastOpened: 0 };
  const refusal = 'LANIUS_MIGRATION_REQUIRED:{"current": 15, "target": 16, "pending": true, "size_bytes": 3865470566}';

  function shell() {
    const opens: unknown[] = [];
    const invoke = vi.fn(async (command: string, args?: { allowMigration?: boolean }) => {
      if (command === 'list_projects') return [saved];
      if (command === 'get_global_lockdown') return { enabled: false, forced: false };
      if (command === 'startup_progress') return null;
      if (command === 'open_project') {
        opens.push(args);
        if (!args?.allowMigration) throw refusal;
        return saved;
      }
      throw new Error(`unexpected command: ${command}`);
    });
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
    return opens;
  }

  const message = t('startup.migration.message', { name: 'hanafn', size: '3.6 GB', current: '15', target: '16' });

  it('asks first, and opens after the user agrees to upgrade', async () => {
    const opens = shell();
    const onOpen = vi.fn();
    const user = userEvent.setup();
    render(<ProjectPicker onOpen={onOpen} />);

    await user.click(await screen.findByRole('button', { name: t('startup.open') }));
    expect(await screen.findByText(message)).toBeTruthy();
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();

    await user.click(screen.getByRole('button', { name: t('startup.migration.confirm') }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(saved));
    expect(opens).toEqual([{ id: 'big', allowMigration: false }, { id: 'big', allowMigration: true }]);
  });

  it('cancels opening the project when the user declines', async () => {
    const opens = shell();
    const onOpen = vi.fn();
    const user = userEvent.setup();
    render(<ProjectPicker onOpen={onOpen} />);

    await user.click(await screen.findByRole('button', { name: t('startup.open') }));
    await screen.findByText(message);
    await user.click(screen.getByRole('button', { name: t('common.cancel') }));

    await waitFor(() => expect(screen.queryByText(message)).toBeNull());
    expect(onOpen).not.toHaveBeenCalled();
    expect(opens).toHaveLength(1);
    expect((screen.getByRole('button', { name: t('startup.open') }) as HTMLButtonElement).disabled).toBe(false);
  });
});

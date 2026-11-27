import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { API_BASE, setApiBase } from './api/client';
import { ProjectPicker } from './ProjectPicker';
import { renderWithI18n as render, t } from './test-utils';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  setApiBase('http://127.0.0.1:12954');
});

it('puts saved projects before the create and temporary choices', async () => {
  const project = { id: 'recent', name: 'Recent work', temporary: false,
    dbPath: '/projects/recent/lanius.sqlite', lastOpened: 10 };
  const invoke = vi.fn(async (command: string) => {
    if (command === 'list_projects') return [project];
    if (command === 'get_global_lockdown') return { enabled: false, forced: false };
    throw new Error(`unexpected command: ${command}`);
  });
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
  render(<ProjectPicker onOpen={vi.fn()} />);

  const existing = await screen.findByRole('heading', { name: t('startup.existingTitle') });
  const temporary = screen.getByRole('heading', { name: t('startup.tempTitle') });
  expect(existing.compareDocumentPosition(temporary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByText('Recent work')).toBeTruthy();
});

it('keeps older projects available without pushing create actions below a long list', async () => {
  const projects = Array.from({ length: 4 }, (_, index) => ({
    id: `p${index}`, name: `Project ${index + 1}`, temporary: false,
    dbPath: `/projects/p${index}/lanius.sqlite`, lastOpened: 4 - index,
  }));
  const invoke = vi.fn(async (command: string) => {
    if (command === 'list_projects') return projects;
    if (command === 'get_global_lockdown') return { enabled: false, forced: false };
    throw new Error(`unexpected command: ${command}`);
  });
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
  render(<ProjectPicker onOpen={vi.fn()} />);

  const showAll = await screen.findByRole('button', {
    name: t('startup.showAllProjects', { count: '4' }),
  });
  expect(screen.queryByText('Project 4')).toBeNull();
  await userEvent.click(showAll);
  expect(screen.getByText('Project 4')).toBeTruthy();
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

it('creates a saved project and applies Burp settings chosen on the landing page', async () => {
  const project = {
    id: 'imported', name: 'demo', temporary: false,
    dbPath: '/projects/imported/lanius.sqlite', lastOpened: 0,
  };
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'list_projects') return [];
    if (command === 'get_global_lockdown') return { enabled: false, forced: false };
    if (command === 'create_project') {
      expect(args).toEqual({ name: 'demo', location: null });
      return project;
    }
    if (command === 'startup_progress') return null;
    throw new Error(`unexpected command: ${command}`);
  });
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
  const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/project/import?settings_only=true')) {
      return { ok: true, json: async () => ({
        ok: true, source: 'burp', flows: 0, scope: 1, workspace: 0,
        match_replace: 1, listeners: 1, skipped: 0, warnings: [],
      }) } as Response;
    }
    if (url.endsWith('/api/lockdown')) {
      return { ok: true, json: async () => ({ effective: false, project_enabled: false }) } as Response;
    }
    throw new Error(`unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetch);
  const onOpen = vi.fn();
  render(<ProjectPicker onOpen={onOpen} />);
  const user = userEvent.setup();
  const file = new File([JSON.stringify({
    target: { scope: { include: [{ enabled: true }] } },
    proxy: { match_replace_rules: [{}], request_listeners: [{}] },
  })], 'demo_burp_config.json', { type: 'application/json' });

  await user.upload(screen.getByLabelText(t('project.importSettings'), { selector: 'input' }), file);
  const dialog = await screen.findByRole('dialog', { name: t('project.importSettings') });
  expect(dialog.textContent).toContain('demo');
  await user.click(screen.getByRole('button', { name: t('project.importSettings') }));

  await waitFor(() => expect(onOpen).toHaveBeenCalledWith(project));
  expect(fetch.mock.calls.find(([url]) => String(url).endsWith('/api/project/import?settings_only=true'))?.[1]).toMatchObject({ body: file });
});

it('creates a project in a folder the user chose', async () => {
  const project = {
    id: 'chosen', name: 'Client', temporary: false,
    dbPath: '/Volumes/Work/Client/lanius.sqlite', lastOpened: 0,
  };
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'list_projects') return [];
    if (command === 'get_global_lockdown') return { enabled: false, forced: false };
    if (command === 'pick_directory') return '/Volumes/Work';
    if (command === 'create_project') return project;
    if (command === 'startup_progress') return null;
    throw new Error(`unexpected command: ${command} ${JSON.stringify(args)}`);
  });
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
  const onOpen = vi.fn();
  const user = userEvent.setup();
  render(<ProjectPicker onOpen={onOpen} />);

  expect(screen.getByText(t('startup.locationDefault'))).toBeTruthy();
  await user.type(screen.getByLabelText(t('startup.name')), 'Client');
  await user.click(screen.getByRole('button', { name: t('startup.locationChoose') }));
  expect(await screen.findByText('/Volumes/Work')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: t('startup.createStart') }));

  await waitFor(() => expect(onOpen).toHaveBeenCalledWith(project));
  expect(invoke).toHaveBeenCalledWith('create_project', { name: 'Client', location: '/Volumes/Work' });
});

it('can go back to the default location before creating a project', async () => {
  const invoke = vi.fn(async (command: string) => {
    if (command === 'list_projects') return [];
    if (command === 'get_global_lockdown') return { enabled: false, forced: false };
    if (command === 'pick_directory') return '/Volumes/Work';
    if (command === 'create_project') return { id: 'p', name: 'P', temporary: false, dbPath: '/p', lastOpened: 0 };
    if (command === 'startup_progress') return null;
    throw new Error(`unexpected command: ${command}`);
  });
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
  const user = userEvent.setup();
  render(<ProjectPicker onOpen={vi.fn()} />);

  await user.type(screen.getByLabelText(t('startup.name')), 'P');
  await user.click(screen.getByRole('button', { name: t('startup.locationChoose') }));
  await user.click(await screen.findByRole('button', { name: t('startup.locationReset') }));
  expect(screen.getByText(t('startup.locationDefault'))).toBeTruthy();
  await user.click(screen.getByRole('button', { name: t('startup.createStart') }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('create_project', { name: 'P', location: null }));
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
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('engine stopped making progress during startup (stage: database)');
  expect(alert.textContent).not.toContain('Error:');
  expect(screen.queryByRole('status', { name: t('startup.progress.launching') })).toBeNull();

  // The doctor is one click away from the failure, not somewhere to find.
  await user.click(within(alert).getByRole('button', { name: t('startup.runDoctor') }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('run_doctor', undefined));
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

describe('managing saved projects', () => {
  const inside = { id: 'a1', name: 'Alpha', temporary: false, dbPath: '/home/.lanius/projects/a1/lanius.sqlite', lastOpened: 1_700_000_000, external: false };
  const outside = { id: 'b2', name: 'Beta', temporary: false, dbPath: '/Volumes/Work/Beta/lanius.sqlite', lastOpened: 0, external: true };

  function shell() {
    let projects = [inside, outside];
    const invoke = vi.fn(async (command: string, args?: { id?: string; name?: string; path?: string }) => {
      if (command === 'list_projects') return projects;
      if (command === 'get_global_lockdown') return { enabled: false, forced: false };
      if (command === 'rename_project') {
        projects = projects.map((project) => project.id === args?.id ? { ...project, name: args?.name ?? '' } : project);
        return projects.find((project) => project.id === args?.id);
      }
      if (command === 'delete_project') {
        projects = projects.filter((project) => project.id !== args?.id);
        return null;
      }
      if (command === 'open_directory') return null;
      throw new Error(`unexpected command: ${command}`);
    });
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
    return invoke;
  }

  it('renames a project from its menu', async () => {
    const invoke = shell();
    const user = userEvent.setup();
    render(<ProjectPicker onOpen={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: t('startup.projectActions', { name: 'Alpha' }) }));
    await user.click(screen.getByRole('menuitem', { name: t('startup.rename') }));
    const field = await screen.findByLabelText(t('startup.name'), { selector: 'dialog input' });
    // The dialog focuses and selects its field on the next frame.
    await waitFor(() => expect(document.activeElement).toBe(field));
    await user.clear(field);
    await user.type(field, 'Gamma');
    await user.click(within(field.closest('dialog')!).getByRole('button', { name: t('startup.rename') }));

    expect(await screen.findByText('Gamma')).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith('rename_project', { id: 'a1', name: 'Gamma' });
  });

  it('deletes a project in the Lanius folder after confirmation', async () => {
    const invoke = shell();
    const user = userEvent.setup();
    render(<ProjectPicker onOpen={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: t('startup.projectActions', { name: 'Alpha' }) }));
    await user.click(screen.getByRole('menuitem', { name: t('startup.delete') }));
    const dialog = screen.getByRole('dialog', { name: t('startup.deleteTitle') });
    expect(dialog.textContent).toContain(t('startup.deleteMessage', { name: 'Alpha' }));
    await user.click(within(dialog).getByRole('button', { name: t('startup.delete') }));

    await waitFor(() => expect(screen.queryByText('Alpha')).toBeNull());
    expect(invoke).toHaveBeenCalledWith('delete_project', { id: 'a1' });
  });

  it('only unlists a project kept in a folder the user chose, and says the data stays', async () => {
    shell();
    const user = userEvent.setup();
    render(<ProjectPicker onOpen={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: t('startup.projectActions', { name: 'Beta' }) }));
    await user.click(screen.getByRole('menuitem', { name: t('startup.remove') }));
    expect(screen.getByRole('dialog', { name: t('startup.removeTitle') }).textContent)
      .toContain(t('startup.removeMessage', { name: 'Beta', folder: '/Volumes/Work/Beta' }));
  });

  it('shows the project folder', async () => {
    const invoke = shell();
    const user = userEvent.setup();
    render(<ProjectPicker onOpen={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: t('startup.projectActions', { name: 'Alpha' }) }));
    await user.click(screen.getByRole('menuitem', { name: t('startup.showFolder') }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('open_directory', { path: '/home/.lanius/projects/a1' }));
  });

  it('does not label every button as starting while a setting is saved', async () => {
    shell();
    let finish: (value: unknown) => void = () => {};
    const invoke = vi.mocked((window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string) => Promise<unknown> } }).__TAURI_INTERNALS__.invoke);
    const respond = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command: string, ...rest: unknown[]) => command === 'set_global_lockdown'
      ? new Promise((resolve) => { finish = resolve; })
      : (respond as (c: string, ...r: unknown[]) => Promise<unknown>)(command, ...rest));
    const user = userEvent.setup();
    render(<ProjectPicker onOpen={vi.fn()} />);
    await screen.findByText('Alpha');
    await user.click(screen.getByRole('checkbox', { name: t('lockdown.global') }));

    expect(screen.queryByText(t('startup.starting'))).toBeNull();
    expect(screen.getAllByRole('button', { name: t('startup.open') })).toHaveLength(2);
    finish({ enabled: true, forced: false });
  });

  it('keeps the MCP / API port under Advanced, explained as not the proxy port', async () => {
    shell();
    render(<ProjectPicker onOpen={vi.fn()} />);
    const port = await screen.findByLabelText(t('mcp.port'));
    const advanced = port.closest('details')!;
    expect(advanced.open).toBe(false);
    expect(within(advanced).getByText(t('startup.portNotProxy'))).toBeTruthy();
  });
});

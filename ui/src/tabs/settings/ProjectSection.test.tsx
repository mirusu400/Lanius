import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { renderWithI18n as render, t } from '../../test-utils';
import { flushAutosaves } from '../autosave';
import { startWorkspaceAutosaves } from '../workspace';
import { getTabs, resetTabs, updateTab } from '../replayStore';
import { getDecoderTabs, patchDecoderTab, resetDecoderTabs } from '../decoderStore';
import { type ReplayTab } from '../replayModel';
import { emptyDecoderTab } from '../decoderModel';
import { getFuzzerWorkspace, newFuzzerDraft, patchFuzzerDraft, resetTarget } from '../fuzzerStore';
import { ProjectSection } from './ProjectSection';

let stop: () => void;
let workspace: Record<string, unknown>;
let imported: Record<string, unknown>;
let failImport: boolean;
let importReady: Promise<void> | null;
let importWarnings: string[];

function replay(id: string, text: string): ReplayTab {
  return { id, title: id, url: 'http://example.test/', text, sending: false, response: null, error: null };
}

function response(body: unknown, status = 200) {
  return { ok: status === 200, status, json: async () => body } as Response;
}

beforeEach(async () => {
  resetTabs();
  resetDecoderTabs();
  resetTarget();
  failImport = false;
  importReady = null;
  importWarnings = [];
  workspace = {
    replay: [replay('old-replay', 'old request')],
    decoder: [{ ...emptyDecoderTab(), input: 'old payload' }],
    fuzzer: { tabs: [newFuzzerDraft('http://old.test', 'GET /old HTTP/1.1')], activeId: null },
  };
  imported = {
    replay: [replay('imported-replay', 'imported request')],
    decoder: [{ ...emptyDecoderTab(), input: 'imported payload' }],
    fuzzer: { tabs: [newFuzzerDraft('http://imported.test', 'GET /imported HTTP/1.1')], activeId: null },
  };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/project/import')) {
      if (importReady) await importReady;
      if (failImport) return response({ detail: 'invalid import' }, 422);
      workspace = imported;
      return response({ ok: true, flows: 0, scope: 0, workspace: Object.keys(imported).length, warnings: importWarnings });
    }
    if (url.includes('/api/workspace/')) {
      const key = url.split('/').pop()!;
      if (init?.method === 'PUT') {
        workspace[key] = JSON.parse(String(init.body)).value;
        return response({ ok: true });
      }
      return response({ value: workspace[key] ?? null });
    }
    if (url.endsWith('/api/lockdown')) return response({ effective: false, project_enabled: false });
    throw new Error(`unexpected request: ${url}`);
  }));
  stop = startWorkspaceAutosaves();
  await flushAutosaves();
});

afterEach(() => {
  cleanup();
  stop();
  resetTabs();
  resetDecoderTabs();
  resetTarget();
  vi.unstubAllGlobals();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

async function upload(file = new File(['{"format":"lanius-project","version":1}'], 'project.json', { type: 'application/json' })) {
  render(<ProjectSection />);
  const user = userEvent.setup();
  await user.upload(screen.getByLabelText(t('project.import'), { selector: 'input' }), file);
  const dialog = screen.getByRole('dialog', { name: t('project.import') });
  await user.click(within(dialog).getByRole('button', { name: t('project.import') }));
}

it('restores all editors and saves future edits into the imported workspace', async () => {
  updateTab('old-replay', { text: 'old pending draft' });
  patchDecoderTab(getDecoderTabs()[0].id, { input: 'old pending payload' });
  await upload();
  await screen.findByText(t('project.imported', { flows: '0', scope: '0' }));
  expect(getTabs().map((tab) => tab.text)).toEqual(['imported request']);
  expect(getDecoderTabs().map((tab) => tab.input)).toEqual(['imported payload']);
  expect(getFuzzerWorkspace().tabs[0].template).toBe('GET /imported HTTP/1.1');
  await flushAutosaves();
  expect((workspace.replay as ReplayTab[])[0].text).toBe('imported request');

  updateTab('imported-replay', { text: 'new imported draft' });
  patchDecoderTab(getDecoderTabs()[0].id, { input: 'new imported payload' });
  patchFuzzerDraft(getFuzzerWorkspace().tabs[0].id, { template: 'GET /new HTTP/1.1' });
  await flushAutosaves();
  expect((workspace.replay as ReplayTab[])[0].text).toBe('new imported draft');
  expect((workspace.decoder as Array<{ input: string }>)[0].input).toBe('new imported payload');
  expect((workspace.fuzzer as { tabs: Array<{ template: string }> }).tabs[0].template).toBe('GET /new HTTP/1.1');
});

it.each([{}, { replay: [], decoder: [] }])('clears old editors when imported tabs are empty: %j', async (empty) => {
  imported = empty;
  await upload();
  await screen.findByText(t('project.imported', { flows: '0', scope: '0' }));
  expect(getTabs()).toEqual([]);
  expect(getDecoderTabs()).toHaveLength(1);
  expect(getDecoderTabs()[0].input).toBe('');
  expect(getFuzzerWorkspace().tabs).toHaveLength(0);
});

it('retains the old draft and autosave when the server rejects the import', async () => {
  failImport = true;
  updateTab('old-replay', { text: 'keep this draft' });
  await upload();
  await waitFor(() => expect(screen.getByText(t('project.importFailed', { message: 'invalid import' }))).toBeTruthy());
  await flushAutosaves();
  expect(getTabs()[0].text).toBe('keep this draft');
  expect((workspace.replay as ReplayTab[])[0].text).toBe('keep this draft');
});

it('accepts a SQLite backup and shows progress until its imported tabs have loaded', async () => {
  let finish: () => void = () => {};
  importReady = new Promise<void>((resolve) => { finish = resolve; });
  const file = new File(['SQLite format 3\0'], 'project.sqlite', { type: 'application/x-sqlite3' });
  await upload(file);
  expect(screen.getByRole('status', { name: t('project.working') })).toBeTruthy();
  expect((screen.getByRole('button', { name: t('project.export') }) as HTMLButtonElement).disabled).toBe(true);
  finish();
  await screen.findByText(t('project.imported', { flows: '0', scope: '0' }));
  expect(screen.queryByRole('status', { name: t('project.working') })).toBeNull();
  expect(getTabs()[0].text).toBe('imported request');
  expect(vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/api/project/import'))?.[1]).toMatchObject({
    body: file, headers: { 'Content-Type': 'application/x-sqlite3' },
  });
});

it('loads the committed workspace when restoration succeeds but the proxy reports a warning', async () => {
  importWarnings = ['Project restored, but the proxy could not restart: port occupied'];
  await upload(new File(['SQLite format 3\0'], 'backup.db'));
  await screen.findByText(importWarnings[0]);
  expect(getTabs()[0].text).toBe('imported request');
  await flushAutosaves();
  expect((workspace.replay as ReplayTab[])[0].text).toBe('imported request');
});

it.each([
  ['project.export', 'json', true],
  ['project.exportNoFlows', 'json', false],
  ['project.backupDatabase', 'database', true],
] as const)('uses a native Save As for %s and saves pending edits before export', async (label, kind, includeFlows) => {
  const invoke = vi.fn(async () => {
    expect((workspace.replay as ReplayTab[])[0].text).toBe('last edit before export');
    return '/chosen/location/project-file';
  });
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
  updateTab('old-replay', { text: 'last edit before export' });
  render(<ProjectSection />);
  await userEvent.setup().click(screen.getByRole('button', { name: t(label) }));
  await screen.findByText(t('project.savedFile', { path: '/chosen/location/project-file' }));
  expect(invoke).toHaveBeenCalledWith('save_project_file', {
    kind, includeFlows, title: t(label),
    defaultName: kind === 'database' ? 'lanius-project.sqlite' : expect.stringMatching(/^lanius-\d{4}-\d{2}-\d{2}\.lanius\.json$/),
  });
});

it('quietly cancels an export when the native Save As is dismissed', async () => {
  const invoke = vi.fn(async () => null);
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
  render(<ProjectSection />);
  await userEvent.setup().click(screen.getByRole('button', { name: t('project.export') }));
  await waitFor(() => expect((screen.getByRole('button', { name: t('project.export') }) as HTMLButtonElement).disabled).toBe(false));
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(/chosen\/location/)).toBeNull();
  expect(document.querySelector('.banner.error')).toBeNull();
});

it('shows a native export failure without claiming the file was saved', async () => {
  const invoke = vi.fn(async () => { throw new Error('disk full'); });
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
  render(<ProjectSection />);
  await userEvent.setup().click(screen.getByRole('button', { name: t('project.backupDatabase') }));
  await screen.findByText('disk full');
  expect(document.querySelector('.banner.error')).toBeTruthy();
});

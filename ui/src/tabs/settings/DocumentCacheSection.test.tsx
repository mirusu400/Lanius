import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Text } from '@codemirror/state';
import { renderWithI18n as render, t } from '../../test-utils';
import { textDocumentCache } from '../../components/textDocumentCache';
import { restoreTextDocumentCacheSettings } from '../../components/textDocumentCacheSettings';
import { flushAutosaves, replaceWorkspace } from '../autosave';
import { startWorkspaceAutosaves } from '../workspace';
import { DocumentCacheSection } from './DocumentCacheSection';
import { searchSettings } from './settingsCatalogue';

let stop: (() => void) | undefined;
let workspace: Record<string, unknown>;
let failSave: boolean;
let savedLimits: unknown[];

beforeEach(async () => {
  workspace = {};
  failSave = false;
  savedLimits = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = String(input).split('/').pop()!;
    if (init?.method === 'PUT') {
      if (failSave && key === 'textDocumentCache') return { ok: false, status: 500, json: async () => ({ detail: 'disk full' }) };
      const value = JSON.parse(String(init.body)).value;
      workspace[key] = value;
      if (key === 'textDocumentCache') savedLimits.push(value);
      return { ok: true, json: async () => ({ ok: true }) };
    }
    return { ok: true, json: async () => ({ value: workspace[key] ?? null }) };
  }));
  stop = startWorkspaceAutosaves();
  await flushAutosaves();
});

afterEach(() => { cleanup(); stop?.(); stop = undefined; vi.unstubAllGlobals(); });

function remember(source: string) {
  const doc = Text.of(source.split('\n'));
  textDocumentCache.put(source, doc, textDocumentCache.generation);
  return doc;
}

it('uses 32 MiB by default and saves an applied limit in the project workspace', async () => {
  render(<DocumentCacheSection />);
  const input = screen.getByRole('spinbutton', { name: t('documentCache.limit') }) as HTMLInputElement;
  expect(input.value).toBe('32');
  fireEvent.change(input, { target: { value: '64' } });
  await userEvent.setup().click(screen.getByRole('button', { name: t('documentCache.apply') }));
  await waitFor(() => expect(workspace.textDocumentCache).toEqual({ limitMiB: 64 }));
  expect(textDocumentCache.getSnapshot().maxBytes).toBe(64 * 1024 * 1024);
  stop!();
  stop = startWorkspaceAutosaves();
  await act(() => flushAutosaves());
  expect(input.value).toBe('64');
});

it('keeps an applied setting when the initial project read is slow', async () => {
  stop!();
  workspace = { textDocumentCache: { limitMiB: 64 } };
  let finishRead!: (response: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>(resolve => { finishRead = resolve; }));
  stop = startWorkspaceAutosaves();
  render(<DocumentCacheSection />);
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '0' } });
  await userEvent.setup().click(screen.getByRole('button', { name: t('documentCache.apply') }));
  await act(async () => finishRead({ ok: true, json: async () => ({ value: { limitMiB: 64 } }) } as Response));
  await waitFor(() => expect(workspace.textDocumentCache).toEqual({ limitMiB: 0 }));
  expect(textDocumentCache.getSnapshot().maxBytes).toBe(0);
});

it('appears in the project settings search in both languages', () => {
  for (const query of ['document cache', '문서 캐시']) {
    expect(searchSettings(query)).toContainEqual(expect.objectContaining({ id: 'document-cache', group: 'project' }));
  }
});

it('clears cached documents and updates usage while an open document stays usable', async () => {
  const source = 'HTTP/1.1 200 OK\r\n\r\n한글😀' + 'x'.repeat(128 * 1024);
  const openDocument = remember(source);
  render(<DocumentCacheSection />);
  expect(textDocumentCache.getSnapshot().count).toBe(1);
  const generation = textDocumentCache.generation;
  await userEvent.setup().click(screen.getByRole('button', { name: t('documentCache.clear') }));
  expect(textDocumentCache.getSnapshot()).toMatchObject({ count: 0, bytes: 0 });
  expect(textDocumentCache.generation).toBeGreaterThan(generation);
  expect(openDocument.sliceString(0, openDocument.length, '\n')).toBe(source);
  expect(screen.getByText(t('documentCache.usage', { size: '0.00', count: 0 }))).toBeTruthy();
  await flushAutosaves();
  expect(savedLimits).toEqual([]);
});

it('allows zero to disable caching and rejects invalid limits', async () => {
  render(<DocumentCacheSection />);
  const input = screen.getByRole('spinbutton', { name: t('documentCache.limit') });
  const apply = screen.getByRole('button', { name: t('documentCache.apply') }) as HTMLButtonElement;
  for (const value of ['', '-1', '1.5', '1025']) {
    fireEvent.change(input, { target: { value } });
    expect(apply.disabled).toBe(true);
  }
  fireEvent.change(input, { target: { value: '0' } });
  await userEvent.setup().click(apply);
  await waitFor(() => expect(workspace.textDocumentCache).toEqual({ limitMiB: 0 }));
  remember('not cached');
  expect(textDocumentCache.get('not cached')).toBeUndefined();
});

it('restores imported limits, resets missing ones and clears the previous document cache', async () => {
  render(<DocumentCacheSection />);
  const input = screen.getByRole('spinbutton', { name: t('documentCache.limit') }) as HTMLInputElement;
  remember('old project document');
  await act(() => replaceWorkspace(async () => {
    workspace = { textDocumentCache: { limitMiB: 4 } };
  }));
  expect(input.value).toBe('4');
  expect(textDocumentCache.get('old project document')).toBeUndefined();
  await act(() => replaceWorkspace(async () => { workspace = {}; }));
  expect(input.value).toBe('32');
});

it.each([null, { limitMiB: -1 }, { limitMiB: 1.5 }, { limitMiB: '64' }, { limitMiB: 1025 }])('falls back to 32 MiB for invalid saved settings: %j', (value) => {
  textDocumentCache.setLimitMiB(64);
  restoreTextDocumentCacheSettings(value);
  expect(textDocumentCache.getSnapshot().maxBytes).toBe(32 * 1024 * 1024);
});

it('shows a persistence failure and lets the same limit be retried', async () => {
  render(<DocumentCacheSection />);
  failSave = true;
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '64' } });
  const apply = screen.getByRole('button', { name: t('documentCache.apply') }) as HTMLButtonElement;
  await userEvent.setup().click(apply);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'disk full');
  expect(apply.disabled).toBe(false);
  failSave = false;
  await userEvent.setup().click(apply);
  await waitFor(() => expect(workspace.textDocumentCache).toEqual({ limitMiB: 64 }));
  expect(screen.queryByRole('alert')).toBeNull();
});

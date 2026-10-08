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
import { ProjectSection } from './ProjectSection';

let stop: () => void;
let workspace: Record<string, unknown>;
let imported: Record<string, unknown>;
let failImport: boolean;

function replay(id: string, text: string): ReplayTab {
  return { id, title: id, url: 'http://example.test/', text, sending: false, response: null, error: null };
}

function response(body: unknown, status = 200) {
  return { ok: status === 200, status, json: async () => body } as Response;
}

beforeEach(async () => {
  resetTabs();
  resetDecoderTabs();
  failImport = false;
  workspace = {
    replay: [replay('old-replay', 'old request')],
    decoder: [{ ...emptyDecoderTab(), input: 'old payload' }],
  };
  imported = {
    replay: [replay('imported-replay', 'imported request')],
    decoder: [{ ...emptyDecoderTab(), input: 'imported payload' }],
  };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/project/import')) {
      if (failImport) return response({ detail: 'invalid import' }, 422);
      workspace = imported;
      return response({ ok: true, flows: 0, scope: 0, workspace: Object.keys(imported).length });
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
  vi.unstubAllGlobals();
});

async function upload() {
  render(<ProjectSection />);
  const user = userEvent.setup();
  const file = new File(['{"format":"lanius-project","version":1}'], 'project.json', { type: 'application/json' });
  await user.upload(screen.getByLabelText(t('project.import'), { selector: 'input' }), file);
  const dialog = screen.getByRole('dialog', { name: t('project.import') });
  await user.click(within(dialog).getByRole('button', { name: t('project.import') }));
}

it('restores both editors and saves future edits into the imported workspace', async () => {
  updateTab('old-replay', { text: 'old pending draft' });
  patchDecoderTab(getDecoderTabs()[0].id, { input: 'old pending payload' });
  await upload();
  await screen.findByText(t('project.imported', { flows: '0', scope: '0' }));
  expect(getTabs().map((tab) => tab.text)).toEqual(['imported request']);
  expect(getDecoderTabs().map((tab) => tab.input)).toEqual(['imported payload']);
  await flushAutosaves();
  expect((workspace.replay as ReplayTab[])[0].text).toBe('imported request');

  updateTab('imported-replay', { text: 'new imported draft' });
  patchDecoderTab(getDecoderTabs()[0].id, { input: 'new imported payload' });
  await flushAutosaves();
  expect((workspace.replay as ReplayTab[])[0].text).toBe('new imported draft');
  expect((workspace.decoder as Array<{ input: string }>)[0].input).toBe('new imported payload');
});

it.each([{}, { replay: [], decoder: [] }])('clears old editors when imported tabs are empty: %j', async (empty) => {
  imported = empty;
  await upload();
  await screen.findByText(t('project.imported', { flows: '0', scope: '0' }));
  expect(getTabs()).toEqual([]);
  expect(getDecoderTabs()).toHaveLength(1);
  expect(getDecoderTabs()[0].input).toBe('');
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

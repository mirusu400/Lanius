import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { flushAutosaves } from './autosave';
import { emptyDecoderTab } from './decoderModel';
import { addDecoderTab, getDecoderTabs, patchDecoderTab, resetDecoderTabs } from './decoderStore';
import { resetTarget } from './fuzzerStore';
import { emptyTab } from './replayModel';
import { getActiveTabId, getTabs, resetTabs, sendTextToReplay } from './replayStore';
import { startWorkspaceAutosaves } from './workspace';

let stop: (() => void) | undefined;
let stored: Record<string, unknown>;
let finishRead: (value: unknown) => void;

function response(value: unknown): Response {
  return { ok: true, status: 200, json: async () => value } as Response;
}

function startWithSlowRead(key: string) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const name = String(input).split('/').at(-1)!;
    if (init?.method === 'PUT') {
      stored[name] = JSON.parse(String(init.body)).value;
      return response({ ok: true });
    }
    if (name === key) {
      return new Promise<Response>((resolve) => {
        finishRead = (value) => resolve(response({ value }));
      });
    }
    return response({ value: null });
  }));
  stop = startWorkspaceAutosaves();
}

beforeEach(() => {
  stored = {};
  resetTabs();
  resetDecoderTabs();
  resetTarget();
  vi.useFakeTimers();
});

afterEach(() => {
  stop?.();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('keeps requests sent to Replay while its saved tabs are loading', async () => {
  const saved = { ...emptyTab(), text: 'saved request' };
  startWithSlowRead('replay');
  const sent = sendTextToReplay('http://sent.test', 'new request', 'Sent');
  finishRead([saved]);
  await vi.runAllTimersAsync();
  await flushAutosaves();

  expect(getTabs().map((tab) => tab.text)).toEqual(['saved request', 'new request']);
  expect(getActiveTabId()).toBe(sent.id);
  expect(stored.replay).toEqual(getTabs());
});

it('keeps Decoder edits made while its saved tabs are loading', async () => {
  const saved = { ...emptyDecoderTab(), input: 'saved payload' };
  startWithSlowRead('decoder');
  patchDecoderTab(getDecoderTabs()[0].id, { input: 'new payload' });
  finishRead([saved]);
  await vi.runAllTimersAsync();
  await flushAutosaves();

  expect(getDecoderTabs().map((tab) => tab.input)).toEqual(['saved payload', 'new payload']);
  expect(stored.decoder).toEqual(getDecoderTabs());
});

it('keeps new Decoder tabs while dropping the untouched startup placeholder', async () => {
  const saved = { ...emptyDecoderTab(), input: 'saved payload' };
  startWithSlowRead('decoder');
  addDecoderTab();
  finishRead([saved]);
  await vi.runAllTimersAsync();

  expect(getDecoderTabs().map((tab) => tab.input)).toEqual(['saved payload', '']);
});

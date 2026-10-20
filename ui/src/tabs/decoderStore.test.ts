import { beforeEach, expect, it } from 'vitest';

import { emptyDecoderTab, resetDecoderIds } from './decoderModel';
import { addDecoderTab, getDecoderTabs, patchDecoderTab, removeDecoderTab, resetDecoderTabs, setDecoderTabs } from './decoderStore';

beforeEach(() => {
  resetDecoderIds();
  resetDecoderTabs();
});

it('creates independent tabs after restoring a previous session', () => {
  const saved = [emptyDecoderTab(), emptyDecoderTab()];
  resetDecoderIds();
  setDecoderTabs(saved);
  addDecoderTab();
  const added = addDecoderTab();

  expect(new Set(getDecoderTabs().map((tab) => tab.id)).size).toBe(4);
  patchDecoderTab(added.id, { input: 'new payload' });
  expect(getDecoderTabs().filter((tab) => tab.input === 'new payload')).toHaveLength(1);
  expect(getDecoderTabs().slice(0, 2)).toEqual(saved);
});

it('repairs duplicate ids in an older workspace without losing either payload', () => {
  const first = { ...emptyDecoderTab(), id: 'd1', input: 'first' };
  const second = { ...emptyDecoderTab(), id: 'd1', input: 'second' };
  setDecoderTabs([first, second]);

  expect(getDecoderTabs().map((tab) => tab.input)).toEqual(['first', 'second']);
  const [a, b] = getDecoderTabs();
  expect(a.id).not.toBe(b.id);
  removeDecoderTab(a.id);
  expect(getDecoderTabs()).toEqual([b]);
});

import { describe, expect, it, vi } from 'vitest';

import { t } from '../test-utils';
import { requestMenuItems } from './requestMenu';

describe('requestMenuItems', () => {
  it('uses the same request actions and ordering for every caller', () => {
    const sendToReplay = vi.fn();
    const sendToFuzzer = vi.fn();
    const copyUrl = vi.fn();
    const copyAs = { label: t('menu.copyAs'), items: [{ label: 'curl' }] };
    const items = requestMenuItems(t, {
      url: 'https://api.test/edited', sendToReplay, sendToFuzzer, copyUrl, copyAs,
    });
    expect(items.map((item) => item.label)).toEqual([
      t('menu.sendToReplay'), t('menu.sendToFuzzer'), t('menu.copyUrl'), t('menu.copyAs'),
    ]);
    items[0].onSelect?.();
    items[1].onSelect?.();
    items[2].onSelect?.();
    expect(sendToReplay).toHaveBeenCalledOnce();
    expect(sendToFuzzer).toHaveBeenCalledOnce();
    expect(copyUrl).toHaveBeenCalledWith('https://api.test/edited');
    expect(items[3]).toBe(copyAs);
  });

  it('disables URL copy for an unfinished request', () => {
    const items = requestMenuItems(t, { url: null });
    expect(items[0]).toMatchObject({ label: t('menu.copyUrl'), disabled: true });
  });

  it('can copy a URL after loading a request by ID', () => {
    const copyUrlAction = vi.fn();
    const items = requestMenuItems(t, { url: null, copyUrlAction });
    expect(items[0].disabled).toBe(false);
    items[0].onSelect?.();
    expect(copyUrlAction).toHaveBeenCalledOnce();
  });

  it('offers hostname and path under both scope rule kinds', () => {
    const addScopeRule = vi.fn();
    const items = requestMenuItems(t, { url: 'https://api.test/x', addScopeRule });
    expect(items.map((item) => item.label)).toEqual([
      t('menu.scopeIncludeRule'), t('menu.scopeExcludeRule'), t('menu.copyUrl'),
    ]);
    items[0].items?.[0].onSelect?.();
    items[0].items?.[1].onSelect?.();
    items[1].items?.[0].onSelect?.();
    items[1].items?.[1].onSelect?.();
    expect(addScopeRule.mock.calls).toEqual([
      ['include', 'hostname'], ['include', 'path'],
      ['exclude', 'hostname'], ['exclude', 'path'],
    ]);
  });
});

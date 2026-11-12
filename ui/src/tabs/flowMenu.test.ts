import { describe, expect, it, vi } from 'vitest';

import { flowMenuItems, flowsMenuItems, flowUrl } from './flowMenu';
import { t } from '../test-utils';
import type { FlowSummary } from '../api/types';

const flow = {
  id: 'f1',
  method: 'GET',
  scheme: 'https',
  host: 'api.example.com',
  port: 443,
  path: '/v1/users',
  query: 'page=2',
} as FlowSummary;

describe('flowUrl', () => {
  it('rebuilds the request URL', () => {
    expect(flowUrl(flow)).toBe('https://api.example.com/v1/users?page=2');
  });

  it('leaves off a default port, the way a browser would', () => {
    expect(flowUrl({ ...flow, port: 443 })).not.toContain(':443');
    expect(flowUrl({ ...flow, scheme: 'http', port: 80 })).not.toContain(':80');
  });

  it('keeps a non-default port, which is the whole point of showing it', () => {
    expect(flowUrl({ ...flow, port: 8443 })).toContain(':8443');
  });

  it('omits an empty query', () => {
    expect(flowUrl({ ...flow, query: null })).toBe('https://api.example.com/v1/users');
  });
});

describe('flowMenuItems', () => {
  const actions = {
    sendToReplay: vi.fn(),
    sendToFuzzer: vi.fn(),
    addScopeRule: vi.fn(),
    copy: vi.fn(),
  };

  it('offers the core request workflow actions', () => {
    const labels = flowMenuItems(flow, t, actions).map((i) => i.label);
    expect(labels).toContain(t('menu.sendToReplay'));
    expect(labels).toContain(t('menu.sendToFuzzer'));
    expect(labels).toContain(t('menu.scopeIncludeRule'));
    expect(labels).toContain(t('menu.scopeExcludeRule'));
  });

  it('copies the URL, not the raw fields', () => {
    const item = flowMenuItems(flow, t, actions).find(
      (i) => i.label === t('menu.copyUrl'),
    );
    item?.onSelect?.();
    expect(actions.copy).toHaveBeenCalledWith(flowUrl(flow));
  });

  it('groups the copy actions away from the destructive ones', () => {
    const items = flowMenuItems(flow, t, actions);
    const copyUrl = items.find((i) => i.label === t('menu.copyUrl'));
    expect(copyUrl?.separator).toBe(true);
  });

  it('carries the copy-as submenu when one is supplied', () => {
    const copyAs = { label: t('menu.copyAs'), items: [{ label: 'curl' }] };
    const items = flowMenuItems(flow, t, actions, copyAs);
    expect(items.at(-1)).toBe(copyAs);
  });

  it('renders without a submenu, so the menu survives a codegen failure', () => {
    const labels = flowMenuItems(flow, t, actions).map((i) => i.label);
    expect(labels).not.toContain(t('menu.copyAs'));
    expect(labels).toContain(t('menu.sendToReplay'));
  });

  it('offers independent bookmark and color actions', () => {
    const toggleBookmark = vi.fn();
    const setColor = vi.fn();
    const items = flowMenuItems(flow, t, { ...actions, toggleBookmark, setColor });
    items.find((item) => item.label === t('history.addBookmark'))?.onSelect?.();
    const colors = items.find((item) => item.label === t('history.highlight'))?.items;
    colors?.find((item) => item.label === t('history.color.blue'))?.onSelect?.();
    expect(toggleBookmark).toHaveBeenCalledWith(flow);
    expect(setColor).toHaveBeenCalledWith(flow, 'blue');
  });
});

const multiFlow = { ...flow, host: 'example.test', query: null } as FlowSummary;

describe('menu for several selected flows', () => {
  const several = [
    { ...multiFlow, id: 'x', path: '/x', bookmarked: true },
    { ...multiFlow, id: 'y', path: '/y', bookmarked: false },
  ];

  it('acts on every selected flow and leaves single-request tools out', () => {
    const actions = {
      sendToReplay: vi.fn(), copy: vi.fn(), setBookmarked: vi.fn(), setColor: vi.fn(), deleteFlows: vi.fn(),
    };
    const items = flowsMenuItems(several, t, actions);
    const labels = items.map((item) => item.label);
    expect(labels).toEqual([
      t('history.selectedCount', { count: '2' }),
      t('history.sendSelectedToReplay', { count: '2' }),
      t('history.bookmarkSelected', { count: '1' }),
      t('history.unbookmarkSelected', { count: '1' }),
      t('history.highlight'),
      t('history.copySelectedUrls', { count: '2' }),
      t('history.deleteSelected', { count: '2' }),
    ]);
    expect(items[0].disabled).toBe(true);
    expect(labels).not.toContain(t('menu.sendToFuzzer'));

    items[1].onSelect?.();
    expect(actions.sendToReplay).toHaveBeenCalledWith(several);
    items[2].onSelect?.();
    expect(actions.setBookmarked).toHaveBeenCalledWith([several[1]], true);
    items[4].items?.[1].onSelect?.();
    expect(actions.setColor).toHaveBeenCalledWith(several, 'red');
    items[5].onSelect?.();
    expect(actions.copy).toHaveBeenCalledWith('https://example.test/x\nhttps://example.test/y');
    expect(items[6].danger).toBe(true);
    items[6].onSelect?.();
    expect(actions.deleteFlows).toHaveBeenCalledWith(several);
  });
});

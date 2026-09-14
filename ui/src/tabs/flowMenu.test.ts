import { describe, expect, it, vi } from 'vitest';

import { flowAsCurl, flowMenuItems, flowUrl } from './flowMenu';
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

describe('flowAsCurl', () => {
  it('quotes the URL so the shell does not split the query', () => {
    expect(flowAsCurl(flow)).toBe("curl 'https://api.example.com/v1/users?page=2'");
  });

  it('names a method other than GET', () => {
    expect(flowAsCurl({ ...flow, method: 'POST' })).toContain('-X POST');
  });

  it('escapes a quote in the URL rather than breaking out of it', () => {
    const odd = { ...flow, path: "/it's" } as FlowSummary;
    expect(flowAsCurl(odd)).toContain("'\\''");
  });
});

describe('flowMenuItems', () => {
  const actions = {
    sendToRepeater: vi.fn(),
    sendToIntruder: vi.fn(),
    addToScope: vi.fn(),
    copy: vi.fn(),
  };

  it('offers the actions Burp users reach for', () => {
    const labels = flowMenuItems(flow, t, actions).map((i) => i.label);
    expect(labels).toContain(t('menu.sendToRepeater'));
    expect(labels).toContain(t('menu.sendToIntruder'));
    expect(labels).toContain(t('menu.addToScope'));
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
});

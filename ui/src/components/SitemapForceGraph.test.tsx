import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderWithI18n as render, t } from '../test-utils';
import { buildTree } from '../tabs/targetModel';
import { layoutSitemapGraph } from './sitemapGraphLayout';
import SitemapForceGraph from './SitemapForceGraph';

const mocks = vi.hoisted(() => {
  const events = new Map<string, (event: unknown) => void>();
  const pointerEvents = new Map<string, () => void>();
  const instance = {
    on: vi.fn((name, callback) => events.set(name, callback)),
    getZr: () => ({ on: (name: string, callback: () => void) => pointerEvents.set(name, callback) }),
    getModel: () => ({ getSeriesByIndex: () => ({ getData: () => ({ count: () => 1, getId: () => '/', getItemLayout: () => [123, 234] }) }) }),
    setOption: vi.fn(), dispatchAction: vi.fn(), resize: vi.fn(), dispose: vi.fn(),
    getWidth: () => 900, getHeight: () => 620, getOption: () => ({ series: [{ zoom: 1.25 }] }),
  };
  return { events, pointerEvents, instance, init: vi.fn(() => instance), disconnect: vi.fn() };
});
vi.mock('echarts/core', () => ({ init: mocks.init, use: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.events.clear();
  mocks.pointerEvents.clear();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect = mocks.disconnect; });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('uses live draggable force layout and retains the chart when graph pages arrive', () => {
  const graph = layoutSitemapGraph(buildTree([], ['/api/users', '/assets']), 160);
  const select = vi.fn();
  const view = render(<SitemapForceGraph nodes={graph.nodes} selectedPath="/" onSelectNode={select} />);
  const option = mocks.instance.setOption.mock.calls[0][0];
  expect(option.series[0]).toMatchObject({ layout: 'force', draggable: true, roam: true, force: { layoutAnimation: true }, emphasis: { focus: 'adjacency' } });
  expect(option.tooltip.renderMode).toBe('richText');
  const updated = layoutSitemapGraph(buildTree([], ['/api/users', '/assets', '/api/teams']), 160);
  view.rerender(<SitemapForceGraph nodes={updated.nodes} selectedPath="/" onSelectNode={select} />);
  expect(mocks.init).toHaveBeenCalledTimes(1);
  expect(mocks.instance.setOption.mock.calls.at(-1)?.[0].series[0].data).toHaveLength(5);
  expect(mocks.instance.setOption.mock.calls.every((call) => call.length === 1)).toBe(true);
  view.unmount();
  expect(mocks.instance.dispose).toHaveBeenCalledOnce();
  expect(mocks.disconnect).toHaveBeenCalledOnce();
});

it('opens a clicked node, ignores drag clicks, and applies button zoom to the chart', () => {
  const graph = layoutSitemapGraph(buildTree([], ['/api/users']), 160);
  const select = vi.fn();
  render(<SitemapForceGraph nodes={graph.nodes} selectedPath="/" onSelectNode={select} />);
  const event = { dataType: 'node', data: { id: '/api/users' } };
  mocks.pointerEvents.get('mousedown')!();
  mocks.pointerEvents.get('drag')!();
  mocks.events.get('click')!(event);
  expect(select).not.toHaveBeenCalled();
  mocks.pointerEvents.get('mousedown')!();
  mocks.events.get('click')!(event);
  expect(select).toHaveBeenCalledWith(graph.nodes[2].node);
  fireEvent.click(screen.getByRole('button', { name: t('target.graphZoomIn') }));
  expect(mocks.instance.setOption).toHaveBeenLastCalledWith({ series: [{ id: 'sitemap', zoom: 1.5625 }] });
  expect(screen.getByRole('button', { name: t('target.graphResetZoom') }).textContent).toBe('156%');
});

it('pauses the solver at its current positions and keeps navigation available through graph changes', () => {
  const graph = layoutSitemapGraph(buildTree([], ['/api/users']), 160);
  const select = vi.fn();
  const view = render(<SitemapForceGraph nodes={graph.nodes} selectedPath="/" onSelectNode={select} />);
  fireEvent.click(screen.getByRole('button', { name: t('target.graphPause') }));
  let series = mocks.instance.setOption.mock.calls.at(-1)![0].series[0];
  expect(series.layout).toBe('none');
  expect(series.data[0]).toMatchObject({ id: '/', x: 123, y: 234 });
  expect(series.roam).toBe(true);
  const updated = layoutSitemapGraph(buildTree([], ['/api/users', '/api/teams']), 160);
  view.rerender(<SitemapForceGraph nodes={updated.nodes} selectedPath="/api" onSelectNode={select} />);
  series = mocks.instance.setOption.mock.calls.at(-1)![0].series[0];
  expect(series.layout).toBe('none');
  expect(series.data.every((node: { x: number; y: number }) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
  mocks.events.get('click')!({ dataType: 'node', data: { id: '/api/users' } });
  expect(select).toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: t('target.graphResume') }));
  expect(mocks.instance.setOption.mock.calls.at(-1)![0].series[0].layout).toBe('force');
});

it('does not restart the solver for unchanged nodes and suspends it while hidden', () => {
  const graph = layoutSitemapGraph(buildTree([], ['/api/users']), 160);
  const select = vi.fn();
  const view = render(<SitemapForceGraph nodes={graph.nodes} selectedPath="/" onSelectNode={select} />);
  const calls = mocks.instance.setOption.mock.calls.length;
  view.rerender(<SitemapForceGraph nodes={[...graph.nodes]} selectedPath="/api" onSelectNode={select} />);
  expect(mocks.instance.setOption).toHaveBeenCalledTimes(calls);
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(mocks.instance.setOption.mock.calls.at(-1)![0].series[0].layout).toBe('none');
  hidden.mockReturnValue(false);
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(mocks.instance.setOption.mock.calls.at(-1)![0].series[0].layout).toBe('force');
  hidden.mockRestore();
});

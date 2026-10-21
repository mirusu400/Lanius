import { useEffect, useRef, useState } from 'react';
import { init, use as registerEcharts, type EChartsType, type ComposeOption } from 'echarts/core';
import { GraphChart, type GraphSeriesOption } from 'echarts/charts';
import { TooltipComponent, type TooltipComponentOption } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { LabelLayout } from 'echarts/features';

import { useT } from '../i18n';
import type { TreeNode } from '../tabs/targetModel';
import type { GraphNode } from './sitemapGraphLayout';

registerEcharts([GraphChart, TooltipComponent, CanvasRenderer, LabelLayout]);
type Option = ComposeOption<GraphSeriesOption | TooltipComponentOption>;
const SERIES_ID = 'sitemap';
const COLORS = ['#69b1ef', '#aa8ce8', '#60cbb0', '#e6b66f', '#e786a7', '#80bd7d'];
function colorFor(group: string) {
  let hash = 0;
  for (const char of group) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return COLORS[(hash >>> 0) % COLORS.length];
}

interface Props {
  nodes: GraphNode[];
  selectedPath: string;
  onSelectNode: (node: TreeNode) => void;
}

/** Only local graph data is passed to ECharts; no remote symbols, images, or datasets. */
export default function SitemapForceGraph({ nodes, selectedPath, onSelectNode }: Props) {
  const t = useT();
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<EChartsType | null>(null);
  const current = useRef({ nodes, onSelectNode });
  const [zoom, setZoom] = useState(1);
  const [paused, setPaused] = useState(false);
  const [hidden, setHidden] = useState(document.hidden);
  const stopped = paused || hidden;
  const rendered = useRef('');
  const positions = useRef(new Map<string, [number, number]>());
  useEffect(() => {
    const update = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  useEffect(() => { current.current = { nodes, onSelectNode }; }, [nodes, onSelectNode]);

  useEffect(() => {
    const element = container.current!;
    const instance = init(element, undefined, { renderer: 'canvas', devicePixelRatio: Math.min(window.devicePixelRatio || 1, 1.5) });
    chart.current = instance;
    let dragged = false;
    const zr = instance.getZr();
    zr.on('mousedown', () => { dragged = false; });
    zr.on('drag', () => { dragged = true; });
    instance.on('click', (event) => {
      if (dragged || event.dataType !== 'node') return;
      const data = event.data as { id?: string } | undefined;
      const match = current.current.nodes.find(({ node }) => node.path === data?.id);
      if (match) current.current.onSelectNode(match.node);
    });
    instance.on('graphroam', () => {
      const option = instance.getOption() as { series?: { zoom?: number }[] };
      setZoom(option.series?.[0]?.zoom ?? 1);
    });
    let resizeFrame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => instance.resize());
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(resizeFrame);
      instance.dispose();
      rendered.current = '';
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    const instance = chart.current!;
    const element = container.current!;
    // ECharts exposes the current force positions on its series data, rather than
    // in getOption(). Snapshot before switching to layout:none to genuinely stop
    // the solver, without moving the graph or disabling click/pan/zoom.
    const snapshotPositions = () => {
      const model = (instance as unknown as {
        getModel(): { getSeriesByIndex(index: number): { getData(): {
          count(): number; getId(index: number): string; getItemLayout(index: number): number[] | undefined;
        } } | undefined };
      }).getModel();
      const data = model?.getSeriesByIndex(0)?.getData();
      const next = new Map<string, [number, number]>();
      for (let index = 0; data && index < data.count(); index++) {
        const point = data.getItemLayout(index);
        if (point && Number.isFinite(point[0]) && Number.isFinite(point[1])) next.set(data.getId(index), [point[0], point[1]]);
      }
      positions.current = next;
    };
    const update = () => {
      const styles = getComputedStyle(element);
      const foreground = styles.getPropertyValue('--fg').trim() || '#dfe3ea';
      const background = styles.getPropertyValue('--bg-sunken').trim() || '#16181c';
      const accent = styles.getPropertyValue('--accent').trim() || '#e2703a';
      const signature = JSON.stringify([stopped, foreground, background, accent, t('target.graphConnections', { count: 0 }), nodes.map(({ node, parent, degree }) => [node.path, node.name, parent, degree])]);
      // Selecting an already visible node only needs a selection action; do not
      // restart the solver when the actual graph has not changed.
      if (rendered.current === signature) return;
      if (rendered.current) snapshotPositions();
      rendered.current = signature;
      const option: Option = {
        animation: !stopped && nodes.length < 200,
        animationDurationUpdate: 400,
        tooltip: {
          trigger: 'item', renderMode: 'richText', confine: true,
          backgroundColor: background, borderWidth: 0, textStyle: { color: foreground, fontSize: 12 },
          formatter: (params) => {
            const item = Array.isArray(params) ? params[0] : params;
            const data = item.data as { id?: string; value?: number } | undefined;
            return item.dataType === 'node' ? `${data?.id ?? ''}\n${t('target.graphConnections', { count: data?.value ?? 0 })}` : '';
          },
        },
        series: [{
          id: SERIES_ID, type: 'graph', layout: stopped ? 'none' : 'force', roam: true, draggable: true, selectedMode: 'single',
          scaleLimit: { min: 0.15, max: 5 }, nodeScaleRatio: 0.6,
          force: { initLayout: 'circular', repulsion: [100, 700], gravity: 0.06, edgeLength: [65, 145], friction: 0.6, layoutAnimation: true },
          data: nodes.map(({ node, parent, group, radius, degree }, index) => ({
            id: node.path, name: node.name,
            // New nodes introduced while paused get deterministic positions.
            x: positions.current.get(node.path)?.[0] ?? instance.getWidth() / 2 + Math.cos(index * 2.39996) * (40 + Math.sqrt(index) * 15),
            y: positions.current.get(node.path)?.[1] ?? instance.getHeight() / 2 + Math.sin(index * 2.39996) * (40 + Math.sqrt(index) * 15),
            value: degree, symbol: 'circle', symbolSize: radius * 2,
            itemStyle: { color: parent ? colorFor(group) : accent, borderColor: background, borderWidth: 1.5 },
            label: { show: parent === null || (nodes.length < 200 && degree >= 4) || nodes.length < 35 },
          })),
          links: nodes.flatMap(({ node, parent, group }) => parent ? [{ source: parent, target: node.path, lineStyle: { color: colorFor(group) } }] : []),
          label: { position: 'right', color: foreground, fontSize: 11, width: 170, overflow: 'truncate' },
          labelLayout: { hideOverlap: true },
          lineStyle: { width: 0.7, curveness: 0, opacity: 0.5 },
          emphasis: { focus: 'adjacency', scale: 1.3, label: { show: true }, lineStyle: { width: 2, opacity: 1 } },
          blur: { itemStyle: { opacity: 0.12 }, lineStyle: { opacity: 0.06 } },
          select: { itemStyle: { borderColor: foreground, borderWidth: 3 }, label: { show: true } },
        }],
      };
      // Merge by stable node IDs: retain dragged positions and the viewport on new pages.
      instance.setOption(option);
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
    return () => observer.disconnect();
  }, [nodes, t, stopped]);

  useEffect(() => {
    const instance = chart.current!;
    instance.dispatchAction({ type: 'unselect', seriesId: SERIES_ID });
    const dataIndex = nodes.findIndex(({ node }) => node.path === selectedPath);
    if (dataIndex >= 0) instance.dispatchAction({ type: 'select', seriesId: SERIES_ID, dataIndex });
  }, [nodes, selectedPath]);

  const changeZoom = (factor: number) => {
    const instance = chart.current!;
    const option = instance.getOption() as { series?: { zoom?: number }[] };
    const next = Math.max(0.15, Math.min(5, (option.series?.[0]?.zoom ?? 1) * factor));
    instance.setOption({ series: [{ id: SERIES_ID, zoom: next }] });
    setZoom(next);
  };
  return <>
    <div ref={container} className="sitemap-echarts" role="img" aria-label={t('target.graphView')} />
    <div className="sitemap-graph-zoom">
      <button aria-pressed={paused} onClick={() => setPaused((value) => !value)}>{t(paused ? 'target.graphResume' : 'target.graphPause')}</button>
      <button aria-label={t('target.graphZoomOut')} disabled={zoom <= 0.15} onClick={() => changeZoom(0.8)}>−</button>
      <button aria-label={t('target.graphResetZoom')} onClick={() => {
        chart.current?.setOption({ series: [{ id: SERIES_ID, center: ['50%', '50%'], zoom: 1 }] });
        setZoom(1);
      }}>{Math.round(zoom * 100)}%</button>
      <button aria-label={t('target.graphZoomIn')} disabled={zoom >= 5} onClick={() => changeZoom(1.25)}>+</button>
    </div>
  </>;
}

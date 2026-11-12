import { useCallback, useRef, useState } from 'react';
import type { FlowSummary, HistorySortKey } from '../api/types';
import { useT } from '../i18n';
import { ResizableFillCell, ResizableFillHeader, ResizableHeader, ResizableTable, useResizableColumns } from './ResizableColumns';
import {
  formatBytes,
  formatDuration,
  formatTime,
  formatUrl,
  statusClass,
} from '../tabs/proxyModel';
import { MarkedText } from './MarkedText';
import { useLocalSourceIpColumn } from '../historySourceColumn';
import { useEgressIpEstimates } from '../useEgressIpEstimates';
import { selectModeOf, type SelectMode } from '../tabs/flowSelection';

interface Props {
  flows: FlowSummary[];
  selectedId: string | null;
  /** Rows selected together with `selectedId`, for actions on several. */
  selectedIds?: ReadonlySet<string>;
  /** `mode` follows the modifier keys: Ctrl/⌘ toggles, Shift extends. */
  onSelect: (id: string, mode?: SelectMode) => void;
  /** Ctrl/⌘+A in the table. */
  onSelectAll?: () => void;
  /** Right-click on a row, for the Proxy tab to build a menu from. */
  onContextMenu?: (event: React.MouseEvent, flow: FlowSummary) => void;
  searchQuery?: string;
  sortBy?: HistorySortKey;
  sortDesc?: boolean;
  onSort?: (key: HistorySortKey) => void;
  onToggleBookmark?: (flow: FlowSummary) => void;
  /** The primary listener, named in the empty-table hint. */
  proxyAddress?: string;
}

const SORT_KEYS: HistorySortKey[] = [
  'started_at', 'method', 'host', 'url', 'status_code', 'modified', 'response_size', 'duration_ms',
];

export function FlowTable({ flows, selectedId, selectedIds, onSelect, onSelectAll, onContextMenu, searchQuery = '', sortBy, sortDesc, onSort, onToggleBookmark, proxyAddress = '127.0.0.1:8080' }: Props) {
  const t = useT();
  const showSourceIp = useLocalSourceIpColumn();
  const publicIpIndex = showSourceIp ? 11 : 10;
  // Last, so layouts saved before this column existed keep their indices.
  const toolIndex = publicIpIndex + 1;
  const [showPublicIp, setShowPublicIp] = useState(false);
  const hiddenChanged = useCallback((hidden: number[]) => {
    setShowPublicIp(!hidden.includes(publicIpIndex));
  }, [publicIpIndex]);
  const publicIps = useEgressIpEstimates(flows, showPublicIp);
  const rows = useRef(new Map<string, HTMLTableRowElement>());
  const isSelected = (id: string) => id === selectedId || Boolean(selectedIds?.has(id));
  const selectAdjacent = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget && !(event.target instanceof HTMLTableRowElement)) return;
    if (onSelectAll && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      onSelectAll();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    if (!flows.length) return;
    event.preventDefault();
    const index = flows.findIndex((flow) => flow.id === selectedId);
    const next = index < 0
      ? (event.key === 'ArrowDown' ? 0 : flows.length - 1)
      : Math.max(0, Math.min(flows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
    const id = flows[next].id;
    onSelect(id, event.shiftKey ? 'range' : 'replace');
    rows.current.get(id)?.focus();
    rows.current.get(id)?.scrollIntoView?.({ block: 'nearest' });
  };
  const baseColumns = useResizableColumns('lanius.columns.history', [64, 48, 84, 70, 180, 260, 66, 82, 78, 84, 180, 72]);
  const sourceColumns = useResizableColumns('lanius.columns.history.source', [64, 48, 84, 70, 180, 260, 66, 82, 78, 84, 135, 180, 72]);
  const columns = showSourceIp ? sourceColumns : baseColumns;
  const headers = [
    t('flow.time'), t('flow.method'), t('flow.host'), t('flow.url'),
    t('flow.status'), t('flow.modified'), t('flow.size'), t('flow.time'),
  ];
  return (
    <div className="flow-table-wrap" tabIndex={0} onKeyDown={selectAdjacent}>
      <ResizableTable columns={columns} className="flow-table"
        defaultHidden={[publicIpIndex]} onHiddenChange={hiddenChanged}>
        <thead>
          <tr>
            <ResizableHeader
              label="#"
              menuLabel={t('flow.requestNumber')}
              index={0}
              columns={columns}
              className="history-number-header"
              resizeLabel={t('table.resizeColumn', { column: t('flow.requestNumber') })}
              onSort={onSort ? () => onSort('request_number') : undefined}
              sortDirection={sortBy === 'request_number' ? (sortDesc ? 'descending' : 'ascending') : undefined}
            />
            <ResizableHeader
              label="★"
              menuLabel={t('history.marks')}
              index={1}
              columns={columns}
              className="history-bookmark-header"
              resizeLabel={t('table.resizeColumn', { column: t('history.marks') })}
            />
            {headers.map((label, index) => (
              <ResizableHeader
                key={index}
                label={label}
                menuLabel={index === 7 ? t('flow.duration') : label}
                index={index + 2}
                columns={columns}
                className={index === 5 ? 'modified-header' : undefined}
                resizeLabel={t('table.resizeColumn', { column: label })}
                onSort={onSort ? () => onSort(SORT_KEYS[index]) : undefined}
                sortDirection={sortBy === SORT_KEYS[index] ? (sortDesc ? 'descending' : 'ascending') : undefined}
              />
            ))}
            {showSourceIp && <ResizableHeader label={t('flow.localSourceIp')} index={10} columns={columns}
              resizeLabel={t('table.resizeColumn', { column: t('flow.localSourceIp') })} />}
            <ResizableHeader label={t('flow.publicIpEstimate')} index={publicIpIndex} columns={columns}
              resizeLabel={t('table.resizeColumn', { column: t('flow.publicIpEstimate') })} />
            <ResizableHeader label={t('flow.tool')} index={toolIndex} columns={columns}
              resizeLabel={t('table.resizeColumn', { column: t('flow.tool') })} />
            <ResizableFillHeader />
          </tr>
        </thead>
        <tbody>
          {flows.length === 0 && (
            <tr>
              <td colSpan={columns.widths.length} className="empty">
                {t('proxy.emptyTable', { proxy: proxyAddress })}
              </td>
              <ResizableFillCell />
            </tr>
          )}
          {flows.map((flow) => (
            <tr
              key={flow.id}
              ref={(element) => { if (element) rows.current.set(flow.id, element); else rows.current.delete(flow.id); }}
              tabIndex={flow.id === selectedId ? 0 : -1}
              aria-selected={isSelected(flow.id)}
              className={[
                isSelected(flow.id) ? 'selected' : '',
                flow.annotation_color ? `annotation-${flow.annotation_color}` : '',
              ].filter(Boolean).join(' ') || undefined}
              // Shift+click would otherwise also select the text in between.
              onMouseDown={(event) => { if (event.shiftKey) event.preventDefault(); }}
              onClick={(event) => { onSelect(flow.id, selectModeOf(event)); event.currentTarget.focus(); }}
              onContextMenu={(event) => {
                // Right-clicking a row should act on that row, not on
                // whatever happened to be selected, unless it is one of
                // several selected rows: then it acts on all of them.
                if (!isSelected(flow.id)) onSelect(flow.id);
                onContextMenu?.(event, flow);
              }}
            >
              <td className="mono num history-number-cell">{flow.request_number ?? '—'}</td>
              <td className="history-bookmark-cell">
                <button
                  type="button"
                  className={`history-bookmark${flow.bookmarked ? ' active' : ''}`}
                  aria-label={flow.bookmarked ? t('history.removeBookmark') : t('history.addBookmark')}
                  aria-pressed={Boolean(flow.bookmarked)}
                  title={flow.bookmarked ? t('history.removeBookmark') : t('history.addBookmark')}
                  onClick={(event) => { event.stopPropagation(); onToggleBookmark?.(flow); }}
                >{flow.bookmarked ? '★' : '☆'}</button>
              </td>
              <td className="mono">{formatTime(flow.started_at)}</td>
              <td className="mono"><MarkedText text={flow.method || ''} query={searchQuery} /></td>
              <td><MarkedText text={flow.host || ''} query={searchQuery} /></td>
              <td className="mono truncate" title={formatUrl(flow)}>
                <MarkedText text={`${flow.path || ''}${flow.query ? `?${flow.query}` : ''}`} query={searchQuery} />
              </td>
              <td className={`mono ${statusClass(flow.status_code)}`} title={flow.error ?? undefined}>
                {flow.status_code ?? (flow.error ? 'ERR' : '…')}
              </td>
              <td
                className={flow.modified ? 'mono col-modified is-modified' : 'mono col-modified'}
                title={flow.modified ? t('flow.modified') : undefined}
              >
                {flow.modified ? '✓' : ''}
              </td>
              <td className="mono num">{formatBytes(flow.response_size)}</td>
              <td className="mono num">{formatDuration(flow.duration_ms)}</td>
              {showSourceIp && <td className="mono" title={t('flow.localSourceIpHint')}>
                {flow.local_source_ip || '—'}
              </td>}
              <td className="mono" title={t('flow.publicIpEstimateHint')}>
                {publicIps[flow.id] || '—'}
              </td>
              <td className="mono" title={t('flow.toolHint')}>
                {flow.source === 'replay' || flow.source === 'fuzzer' ? t(`flow.tool.${flow.source}`) : ''}
              </td>
              <ResizableFillCell />
            </tr>
          ))}
        </tbody>
      </ResizableTable>
    </div>
  );
}

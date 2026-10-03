import { useRef } from 'react';
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

interface Props {
  flows: FlowSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Right-click on a row, for the Proxy tab to build a menu from. */
  onContextMenu?: (event: React.MouseEvent, flow: FlowSummary) => void;
  searchQuery?: string;
  sortBy?: HistorySortKey;
  sortDesc?: boolean;
  onSort?: (key: HistorySortKey) => void;
  onToggleBookmark?: (flow: FlowSummary) => void;
}

const SORT_KEYS: HistorySortKey[] = [
  'started_at', 'method', 'host', 'url', 'status_code', 'modified', 'response_size', 'duration_ms',
];

export function FlowTable({ flows, selectedId, onSelect, onContextMenu, searchQuery = '', sortBy, sortDesc, onSort, onToggleBookmark }: Props) {
  const t = useT();
  const rows = useRef(new Map<string, HTMLTableRowElement>());
  const selectAdjacent = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    if (event.target !== event.currentTarget && !(event.target instanceof HTMLTableRowElement)) return;
    if (!flows.length) return;
    event.preventDefault();
    const index = flows.findIndex((flow) => flow.id === selectedId);
    const next = index < 0
      ? (event.key === 'ArrowDown' ? 0 : flows.length - 1)
      : Math.max(0, Math.min(flows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
    const id = flows[next].id;
    onSelect(id);
    rows.current.get(id)?.focus();
    rows.current.get(id)?.scrollIntoView?.({ block: 'nearest' });
  };
  const columns = useResizableColumns('lanius.columns.history', [48, 84, 70, 180, 260, 66, 82, 78, 84]);
  const headers = [
    t('flow.time'), t('flow.method'), t('flow.host'), t('flow.url'),
    t('flow.status'), t('flow.modified'), t('flow.size'), t('flow.time'),
  ];
  return (
    <div className="flow-table-wrap" tabIndex={0} onKeyDown={selectAdjacent}>
      <ResizableTable columns={columns} className="flow-table">
        <thead>
          <tr>
            <ResizableHeader
              label="★"
              index={0}
              columns={columns}
              className="history-bookmark-header"
              resizeLabel={t('table.resizeColumn', { column: t('history.marks') })}
            />
            {headers.map((label, index) => (
              <ResizableHeader
                key={index}
                label={label}
                index={index + 1}
                columns={columns}
                className={index === 5 ? 'modified-header' : undefined}
                resizeLabel={t('table.resizeColumn', { column: label })}
                onSort={onSort ? () => onSort(SORT_KEYS[index]) : undefined}
                sortDirection={sortBy === SORT_KEYS[index] ? (sortDesc ? 'descending' : 'ascending') : undefined}
              />
            ))}
            <ResizableFillHeader />
          </tr>
        </thead>
        <tbody>
          {flows.length === 0 && (
            <tr>
              <td colSpan={9} className="empty">
                {t('proxy.emptyTable')}
              </td>
              <ResizableFillCell />
            </tr>
          )}
          {flows.map((flow) => (
            <tr
              key={flow.id}
              ref={(element) => { if (element) rows.current.set(flow.id, element); else rows.current.delete(flow.id); }}
              tabIndex={flow.id === selectedId ? 0 : -1}
              className={[
                flow.id === selectedId ? 'selected' : '',
                flow.annotation_color ? `annotation-${flow.annotation_color}` : '',
              ].filter(Boolean).join(' ') || undefined}
              onClick={(event) => { onSelect(flow.id); event.currentTarget.focus(); }}
              onContextMenu={(event) => {
                // Right-clicking a row should act on that row, not on
                // whatever happened to be selected.
                onSelect(flow.id);
                onContextMenu?.(event, flow);
              }}
            >
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
              <td className={`mono ${statusClass(flow.status_code)}`}>
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
              <ResizableFillCell />
            </tr>
          ))}
        </tbody>
      </ResizableTable>
    </div>
  );
}

import type { FlowSummary } from '../api/types';
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
}

export function FlowTable({ flows, selectedId, onSelect, onContextMenu, searchQuery = '' }: Props) {
  const t = useT();
  const columns = useResizableColumns('lanius.columns.history', [84, 70, 180, 260, 66, 82, 78, 84]);
  const headers = [
    t('flow.time'), t('flow.method'), t('flow.host'), t('flow.url'),
    t('flow.status'), t('flow.modified'), t('flow.size'), t('flow.time'),
  ];
  return (
    <div className="flow-table-wrap">
      <ResizableTable columns={columns} className="flow-table">
        <thead>
          <tr>
            {headers.map((label, index) => (
              <ResizableHeader
                key={index}
                label={label}
                index={index}
                columns={columns}
                className={index === 5 ? 'modified-header' : undefined}
                resizeLabel={t('table.resizeColumn', { column: label })}
              />
            ))}
            <ResizableFillHeader />
          </tr>
        </thead>
        <tbody>
          {flows.length === 0 && (
            <tr>
              <td colSpan={8} className="empty">
                {t('proxy.emptyTable')}
              </td>
              <ResizableFillCell />
            </tr>
          )}
          {flows.map((flow) => (
            <tr
              key={flow.id}
              className={flow.id === selectedId ? 'selected' : undefined}
              onClick={() => onSelect(flow.id)}
              onContextMenu={(event) => {
                // Right-clicking a row should act on that row, not on
                // whatever happened to be selected.
                onSelect(flow.id);
                onContextMenu?.(event, flow);
              }}
            >
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

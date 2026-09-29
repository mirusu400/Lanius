import type { FlowSummary } from '../api/types';
import { useT } from '../i18n';
import { ResizableHeader, useResizableColumns } from './ResizableColumns';
import {
  formatBytes,
  formatDuration,
  formatTime,
  formatUrl,
  statusClass,
} from '../tabs/proxyModel';

interface Props {
  flows: FlowSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Right-click on a row, for the Proxy tab to build a menu from. */
  onContextMenu?: (event: React.MouseEvent, flow: FlowSummary) => void;
}

export function FlowTable({ flows, selectedId, onSelect, onContextMenu }: Props) {
  const t = useT();
  const columns = useResizableColumns('lanius.columns.history', [84, 70, 180, 260, 66, 82, 78, 84]);
  const headers = [
    t('flow.time'), t('flow.method'), t('flow.host'), t('flow.url'),
    t('flow.status'), t('flow.modified'), t('flow.size'), t('flow.time'),
  ];
  return (
    <div className="flow-table-wrap">
      <table className="flow-table" style={{ width: `max(100%, ${columns.widths.reduce((sum, width) => sum + width, 0)}px)` }}>
        <colgroup>{columns.widths.map((width, index) => <col key={index} style={{ width }} />)}</colgroup>
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
          </tr>
        </thead>
        <tbody>
          {flows.length === 0 && (
            <tr>
              <td colSpan={8} className="empty">
                {t('proxy.emptyTable')}
              </td>
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
              <td className="mono">{flow.method}</td>
              <td>{flow.host}</td>
              <td className="mono truncate" title={formatUrl(flow)}>
                {flow.path}
                {flow.query ? `?${flow.query}` : ''}
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
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

import type { FlowSummary } from '../api/types';
import { useT } from '../i18n';
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
  return (
    <div className="flow-table-wrap">
      <table className="flow-table">
        <thead>
          <tr>
            <th className="col-time">{t('flow.time')}</th>
            <th className="col-method">{t('flow.method')}</th>
            <th className="col-host">{t('flow.host')}</th>
            <th className="col-url">{t('flow.url')}</th>
            <th className="col-status">{t('flow.status')}</th>
            <th className="col-modified">{t('flow.modified')}</th>
            <th className="col-size">{t('flow.size')}</th>
            <th className="col-time">{t('flow.time')}</th>
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

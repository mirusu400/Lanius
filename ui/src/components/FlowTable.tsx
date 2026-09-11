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
}

export function FlowTable({ flows, selectedId, onSelect }: Props) {
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
            <th className="col-size">{t('flow.size')}</th>
            <th className="col-time">{t('flow.time')}</th>
          </tr>
        </thead>
        <tbody>
          {flows.length === 0 && (
            <tr>
              <td colSpan={7} className="empty">
                {t('proxy.emptyTable')}
              </td>
            </tr>
          )}
          {flows.map((flow) => (
            <tr
              key={flow.id}
              className={flow.id === selectedId ? 'selected' : undefined}
              onClick={() => onSelect(flow.id)}
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
              <td className="mono num">{formatBytes(flow.response_size)}</td>
              <td className="mono num">{formatDuration(flow.duration_ms)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

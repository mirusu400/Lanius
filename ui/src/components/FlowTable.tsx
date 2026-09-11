import type { FlowSummary } from '../api/types';
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
  return (
    <div className="flow-table-wrap">
      <table className="flow-table">
        <thead>
          <tr>
            <th className="col-time">Time</th>
            <th className="col-method">Method</th>
            <th className="col-host">Host</th>
            <th className="col-url">URL</th>
            <th className="col-status">Status</th>
            <th className="col-size">Size</th>
            <th className="col-time">Time</th>
          </tr>
        </thead>
        <tbody>
          {flows.length === 0 && (
            <tr>
              <td colSpan={7} className="empty">
                아직 캡처된 트래픽이 없습니다. 브라우저/클라이언트 프록시를
                127.0.0.1:8080 으로 설정하세요.
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

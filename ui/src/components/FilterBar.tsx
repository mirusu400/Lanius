import type { ConnectionState } from '../api/stream';
import type { EngineStatus, FlowFilters } from '../api/types';

interface Props {
  filters: FlowFilters;
  onChange: (filters: FlowFilters) => void;
  paused: boolean;
  onTogglePause: () => void;
  onClear: () => void;
  onReload: () => void;
  connection: ConnectionState;
  status: EngineStatus | null;
  count: number;
}

const METHODS = ['', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export function FilterBar({
  filters,
  onChange,
  paused,
  onTogglePause,
  onClear,
  onReload,
  connection,
  status,
  count,
}: Props) {
  return (
    <div className="filter-bar">
      <input
        className="search"
        placeholder="host / path 검색"
        value={filters.search ?? ''}
        onChange={(e) =>
          onChange({ ...filters, search: e.target.value || undefined })
        }
      />
      <input
        className="host"
        placeholder="host"
        value={filters.host ?? ''}
        onChange={(e) =>
          onChange({ ...filters, host: e.target.value || undefined })
        }
      />
      <select
        value={filters.method ?? ''}
        onChange={(e) =>
          onChange({ ...filters, method: e.target.value || undefined })
        }
      >
        {METHODS.map((m) => (
          <option key={m} value={m}>
            {m || 'method'}
          </option>
        ))}
      </select>
      <input
        className="status-filter"
        placeholder="status"
        value={filters.statusCode ?? ''}
        onChange={(e) =>
          onChange({
            ...filters,
            statusCode: e.target.value ? Number(e.target.value) : undefined,
          })
        }
      />
      <button onClick={onTogglePause}>{paused ? '▶ 재개' : '⏸ 일시정지'}</button>
      <button onClick={onReload}>새로고침</button>
      <button className="danger" onClick={onClear}>
        비우기
      </button>
      <span className="spacer" />
      <span className="count">{count} flows</span>
      <span className={`conn conn-${connection}`}>
        {connection === 'open' ? '● live' : `○ ${connection}`}
      </span>
      {status && (
        <span className="engine-info mono">
          proxy {status.proxy.host}:{status.proxy.port}
        </span>
      )}
    </div>
  );
}

import type { ConnectionState } from '../api/stream';
import { useT } from '../i18n';
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
  const t = useT();
  return (
    <div className="filter-bar">
      <input
        className="search"
        placeholder={t('proxy.searchPlaceholder')}
        value={filters.search ?? ''}
        onChange={(e) =>
          onChange({ ...filters, search: e.target.value || undefined })
        }
      />
      <input
        className="host"
        placeholder={t('proxy.hostPlaceholder')}
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
            {m || t('proxy.methodPlaceholder')}
          </option>
        ))}
      </select>
      <input
        className="status-filter"
        placeholder={t('proxy.statusPlaceholder')}
        value={filters.statusCode ?? ''}
        onChange={(e) =>
          onChange({
            ...filters,
            statusCode: e.target.value ? Number(e.target.value) : undefined,
          })
        }
      />
      <button onClick={onTogglePause}>{paused ? t('common.resume') : t('common.pause')}</button>
      <button onClick={onReload}>{t('common.refresh')}</button>
      <button className="danger" onClick={onClear}>
        {t('common.clear')}
      </button>
      <span className="spacer" />
      <span className="count">{t('proxy.flowCount', { count })}</span>
      <span className={`conn conn-${connection}`}>
        {connection === 'open'
          ? t('proxy.live')
          : t('proxy.connState', { state: connection })}
      </span>
      {status && (
        <span className="engine-info mono">
          proxy {status.proxy.host}:{status.proxy.port}
        </span>
      )}
    </div>
  );
}

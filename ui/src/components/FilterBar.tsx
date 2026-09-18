import type { ConnectionState } from '../api/stream';
import { useT } from '../i18n';
import { countActive } from './FilterDialog';
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
  onOpenFilter: () => void;
  count: number;
}

export function FilterBar({
  filters,
  onChange,
  paused,
  onTogglePause,
  onClear,
  onReload,
  connection,
  status,
  onOpenFilter,
  count,
}: Props) {
  const t = useT();
  const active = countActive(filters);
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
      {/* Everything except the search moved into the dialog: host,
          method and status were three controls that answered one
          question each, and a capture needs several answers at once. */}
      <button className={active > 0 ? 'active' : undefined} onClick={onOpenFilter}>
        {active > 0
          ? t('filter.buttonActive', { count: String(active) })
          : t('filter.button')}
      </button>
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
      {status?.proxy && (
        <span className="engine-info mono">
          proxy {status.proxy.host}:{status.proxy.port}
        </span>
      )}
    </div>
  );
}

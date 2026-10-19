import type { ConnectionState } from '../api/stream';
import { useT } from '../i18n';
import { countActive } from './FilterDialog';
import type { EngineStatus, FlowFilters } from '../api/types';
import { UndoableInput } from './UndoableText';

export type HistoryLayout = 'side-by-side' | 'stacked';

interface Props {
  filters: FlowFilters;
  onChange: (filters: FlowFilters) => void;
  paused: boolean;
  onTogglePause: () => void;
  onClear: () => void;
  clearBusy: boolean;
  onReload: () => void;
  connection: ConnectionState;
  status: EngineStatus | null;
  onOpenFilter: () => void;
  count: number;
  historyLayout: HistoryLayout;
  onToggleHistoryLayout: () => void;
}

function HistoryLayoutIcon({ target }: { target: HistoryLayout }) {
  return (
    <svg
      className="history-layout-icon"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="2.25" y="2.25" width="13.5" height="13.5" rx="1.5" />
      {target === 'stacked'
        ? <path d="M2.5 8.25h13" />
        : <path d="M8.25 2.5v13" />}
    </svg>
  );
}

export function FilterBar({
  filters,
  onChange,
  paused,
  onTogglePause,
  onClear,
  clearBusy,
  onReload,
  connection,
  status,
  onOpenFilter,
  count,
  historyLayout,
  onToggleHistoryLayout,
}: Props) {
  const t = useT();
  const active = countActive(filters);
  const targetLayout = historyLayout === 'side-by-side' ? 'stacked' : 'side-by-side';
  const layoutLabel = targetLayout === 'stacked'
    ? t('proxy.switchToStackedLayout')
    : t('proxy.switchToSideBySideLayout');
  return (
    <div className="filter-bar">
      <UndoableInput
        className="search"
        placeholder={t('proxy.searchPlaceholder')}
        value={filters.search ?? ''}
        onValueChange={(value) =>
          onChange({ ...filters, search: value || undefined })
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
      <button
        className={filters.bookmarkedOnly ? 'active' : undefined}
        aria-pressed={Boolean(filters.bookmarkedOnly)}
        onClick={() => onChange({ ...filters, bookmarkedOnly: !filters.bookmarkedOnly })}
      >★ {t('history.bookmarkedOnly')}</button>
      <button onClick={onTogglePause}>{paused ? t('common.resume') : t('common.pause')}</button>
      <button onClick={onReload}>{t('common.refresh')}</button>
      <button className="danger" onClick={onClear} disabled={clearBusy} aria-busy={clearBusy}>
        {clearBusy ? t('proxy.clearing') : t('common.clear')}
      </button>
      <span className="spacer" />
      <button
        type="button"
        className="history-layout-toggle"
        aria-label={layoutLabel}
        aria-pressed={historyLayout === 'stacked'}
        title={layoutLabel}
        onClick={onToggleHistoryLayout}
      >
        <HistoryLayoutIcon target={targetLayout} />
      </button>
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

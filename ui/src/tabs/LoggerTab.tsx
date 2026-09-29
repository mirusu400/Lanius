import { useCallback, useEffect, useRef, useState } from 'react';

import { listEvents, type LogEvent } from '../api/client';
import { connectStream } from '../api/stream';
import { formatTime } from './proxyModel';
import { useT } from '../i18n';
import { useReportBusy } from '../components/busy';
import { ResizableFillCell, ResizableFillHeader, ResizableHeader, ResizableTable, useResizableColumns } from '../components/ResizableColumns';
import { Split } from '../components/Split';

const MAX_LIVE = 500;

interface LiveEntry {
  key: string;
  ts: number;
  type: string;
  detail: string;
}

export function LoggerTab() {
  const t = useT();
  const liveColumns = useResizableColumns('lanius.columns.logger.live', [90, 180, 440]);
  const storedColumns = useResizableColumns('lanius.columns.logger.stored', [90, 520]);
  const [stored, setStored] = useState<LogEvent[]>([]);
  const [live, setLive] = useState<LiveEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState('');
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const counter = useRef(0);

  const [loading, setLoading] = useState(true);
  useReportBusy('logger', loading);

  const refresh = useCallback(async () => {
    try {
      setStored((await listEvents()).items);
    } catch {
      setStored([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(
    () =>
      connectStream({
        onEvent: (event) => {
          if (pausedRef.current) return;
          counter.current += 1;
          const detail = JSON.stringify(event.data ?? {});
          setLive((prev) =>
            [
              {
                key: `e${counter.current}`,
                ts: Date.now() / 1000,
                type: event.type,
                detail: detail.length > 300 ? `${detail.slice(0, 300)}…` : detail,
              },
              ...prev,
            ].slice(0, MAX_LIVE),
          );
        },
      }),
    [],
  );

  const needle = filter.toLowerCase();
  const visible = live.filter(
    (entry) =>
      !needle ||
      entry.type.toLowerCase().includes(needle) ||
      entry.detail.toLowerCase().includes(needle),
  );

  return (
    <div className="logger-tab">
      <div className="logger-controls">
        <input
          aria-label={t('logger.filter')}
          placeholder={t('logger.filterPlaceholder')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button onClick={() => setPaused((p) => !p)}>
          {paused ? t('common.resume') : t('common.pause')}
        </button>
        <button onClick={() => setLive([])}>{t('common.clear')}</button>
        <button onClick={() => void refresh()}>{t('logger.reloadStored')}</button>
        <span className="spacer" />
        <span className="muted">
          {t('logger.counts', {
            live: visible.length,
            stored: stored.length,
          })}
        </span>
      </div>

      <Split
        direction="horizontal"
        storageKey="lanius.split.logger"
        className="logger-split"
        first={<div className="logger-live">
          <h4>{t('logger.liveEvents')}</h4>
          <ResizableTable columns={liveColumns} className="flow-table">
            <thead><tr>
              {[t('flow.time'), t('logger.eventType'), t('logger.detail')].map((label, index) => (
                <ResizableHeader key={index} label={label} index={index} columns={liveColumns} resizeLabel={t('table.resizeColumn', { column: label })} />
              ))}
              <ResizableFillHeader />
            </tr></thead>
            <tbody>
              {visible.length === 0 && (
                <tr>
                  <td colSpan={3} className="empty">{t('logger.noEvents')}</td>
                  <ResizableFillCell />
                </tr>
              )}
              {visible.map((entry) => (
                <tr key={entry.key}>
                  <td className="mono col-time">{formatTime(entry.ts)}</td>
                  <td className="mono log-type">{entry.type}</td>
                  <td className="mono log-detail">{entry.detail}</td>
                  <ResizableFillCell />
                </tr>
              ))}
            </tbody>
          </ResizableTable>
        </div>}
        second={<div className="logger-stored">
          <h4>{t('logger.storedEvents')}</h4>
          <ResizableTable columns={storedColumns} className="flow-table">
            <thead><tr>
              {[t('flow.time'), t('logger.message')].map((label, index) => (
                <ResizableHeader key={index} label={label} index={index} columns={storedColumns} resizeLabel={t('table.resizeColumn', { column: label })} />
              ))}
              <ResizableFillHeader />
            </tr></thead>
            <tbody>
              {stored.map((event) => (
                <tr key={event.id}>
                  <td className="mono col-time">{formatTime(event.ts)}</td>
                  <td className="mono log-detail">{event.message}</td>
                  <ResizableFillCell />
                </tr>
              ))}
            </tbody>
          </ResizableTable>
        </div>}
      />
    </div>
  );
}

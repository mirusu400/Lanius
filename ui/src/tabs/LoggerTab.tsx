import { useCallback, useEffect, useRef, useState } from 'react';

import { listEvents, type LogEvent } from '../api/client';
import { connectStream } from '../api/stream';
import { formatTime } from './proxyModel';
import { useT } from '../i18n';
import { useReportBusy } from '../components/busy';

const MAX_LIVE = 500;

interface LiveEntry {
  key: string;
  ts: number;
  type: string;
  detail: string;
}

export function LoggerTab() {
  const t = useT();
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

      <div className="logger-split">
        <div className="logger-live">
          <h4>{t('logger.liveEvents')}</h4>
          <table className="flow-table">
            <tbody>
              {visible.length === 0 && (
                <tr>
                  <td className="empty">{t('logger.noEvents')}</td>
                </tr>
              )}
              {visible.map((entry) => (
                <tr key={entry.key}>
                  <td className="mono col-time">{formatTime(entry.ts)}</td>
                  <td className="mono log-type">{entry.type}</td>
                  <td className="mono log-detail">{entry.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="logger-stored">
          <h4>{t('logger.storedEvents')}</h4>
          <table className="flow-table">
            <tbody>
              {stored.map((event) => (
                <tr key={event.id}>
                  <td className="mono col-time">{formatTime(event.ts)}</td>
                  <td className="mono log-detail">{event.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

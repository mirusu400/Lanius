import { useEffect, useMemo, useRef, useState } from 'react';

import { clearPluginLogs, getPluginLogs } from '../api/client';
import type { PluginLogEntry } from '../api/types';
import { useT } from '../i18n';

const POLL_INTERVAL_MS = 750;

export function PluginLogConsole({ plugin }: { plugin: string }) {
  const t = useT();
  const [entries, setEntries] = useState<PluginLogEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const [autoFollow, setAutoFollow] = useState(true);
  const [wrap, setWrap] = useState(true);
  const [level, setLevel] = useState('all');
  const [source, setSource] = useState('all');
  const [search, setSearch] = useState('');
  const [dropped, setDropped] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const cursor = useRef(0);
  const viewport = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (paused) return undefined;
    let disposed = false;
    let busy = false;

    const poll = async () => {
      if (disposed || busy) return;
      busy = true;
      try {
        const page = await getPluginLogs(plugin, cursor.current);
        if (disposed) return;
        cursor.current = page.next_sequence;
        setDropped(page.dropped);
        if (page.items.length > 0) {
          setEntries((current) => {
            const known = new Set(current.map((entry) => entry.sequence));
            return [...current, ...page.items.filter((entry) => !known.has(entry.sequence))]
              .sort((left, right) => left.sequence - right.sequence)
              .slice(-500);
          });
        }
        setError(null);
      } catch (reason) {
        if (!disposed) setError((reason as Error).message);
      } finally {
        busy = false;
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [paused, plugin]);

  useEffect(() => {
    if (autoFollow && viewport.current) {
      viewport.current.scrollTop = viewport.current.scrollHeight;
    }
  }, [autoFollow, entries]);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return entries.filter((entry) => (
      (level === 'all' || entry.level === level)
      && (source === 'all' || entry.source === source)
      && (!query || entry.message.toLowerCase().includes(query))
    ));
  }, [entries, level, search, source]);

  const clear = async () => {
    try {
      const page = await clearPluginLogs(plugin);
      cursor.current = page.next_sequence;
      setEntries([]);
      setDropped(page.dropped);
      setError(null);
    } catch (reason) {
      setError((reason as Error).message);
    }
  };

  const copy = async () => {
    const text = visible.map((entry) => (
      `${new Date(entry.timestamp * 1000).toISOString()} ${entry.source} ${entry.level} ${entry.message}`
    )).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setError(null);
    } catch (reason) {
      setError((reason as Error).message);
    }
  };

  return (
    <section className="plugin-log-console" aria-label={t('plugins.logsFor', { name: plugin })}>
      <div className="plugin-log-toolbar">
        <button onClick={() => setPaused((current) => !current)}>
          {paused ? t('common.resume') : t('common.pause')}
        </button>
        <button onClick={() => void clear()}>{t('common.clear')}</button>
        <button onClick={() => void copy()}>{t('plugins.copyLogs')}</button>
        <select aria-label={t('plugins.logLevel')} value={level} onChange={(event) => setLevel(event.target.value)}>
          <option value="all">{t('plugins.allLevels')}</option>
          <option value="debug">debug</option>
          <option value="info">info</option>
          <option value="warning">warning</option>
          <option value="error">error</option>
          <option value="critical">critical</option>
        </select>
        <select aria-label={t('plugins.logSource')} value={source} onChange={(event) => setSource(event.target.value)}>
          <option value="all">{t('plugins.allSources')}</option>
          {['sdk', 'logging', 'stdout', 'stderr', 'host'].map((item) => (
            <option key={item} value={item}>{item}</option>
          ))}
        </select>
        <input
          aria-label={t('plugins.searchLogs')}
          placeholder={t('plugins.searchLogs')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <label><input type="checkbox" checked={autoFollow} onChange={(event) => setAutoFollow(event.target.checked)} /> {t('plugins.autoFollow')}</label>
        <label><input type="checkbox" checked={wrap} onChange={(event) => setWrap(event.target.checked)} /> {t('plugins.wrapLines')}</label>
      </div>
      {dropped > 0 && <div className="banner warning">{t('plugins.logsDropped', { count: dropped })}</div>}
      {error && <div className="banner error">{error}</div>}
      <div ref={viewport} className={`plugin-log-viewport mono${wrap ? ' wrap' : ''}`}>
        {visible.map((entry) => (
          <div key={entry.sequence} className={`plugin-log-row plugin-log-${entry.level}`}>
            <time>{new Date(entry.timestamp * 1000).toLocaleTimeString()}</time>
            <span className={`plugin-log-source source-${entry.source}`}>{entry.source}</span>
            <span className="plugin-log-level">{entry.level}</span>
            <span className="plugin-log-message">{entry.message}</span>
          </div>
        ))}
        {visible.length === 0 && <p className="muted">{t('plugins.noLogs')}</p>}
      </div>
    </section>
  );
}

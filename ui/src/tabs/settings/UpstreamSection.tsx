/** Ordered upstream proxy chain for the browser-facing listener. */

import { useEffect, useState } from 'react';

import { getUpstream, setUpstream } from '../../api/client';
import type { UpstreamState } from '../../api/types';
import { msg, rawMsg, renderMessage, useI18n, type Message } from '../../i18n';

export function UpstreamSection() {
  const { t } = useI18n();
  const [saved, setSaved] = useState<UpstreamState | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [hops, setHops] = useState<string[]>(['']);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Message | null>(null);
  const [error, setError] = useState<Message | null>(null);

  const load = (state: UpstreamState) => {
    setSaved(state);
    setEnabled(state.enabled);
    setHops(state.hops.length ? state.hops : ['']);
  };

  useEffect(() => {
    getUpstream().then(load).catch((err) => setError(rawMsg((err as Error).message)));
  }, []);

  if (!saved) return error ? <section><div className="banner error">{renderMessage(error, t)}</div></section> : null;

  const configured = enabled ? hops.map((hop) => hop.trim()) : [];
  const changed = configured.length !== saved.hops.length || configured.some((hop, index) => hop !== saved.hops[index]);
  const valid = !enabled || (configured.length > 0 && configured.every(Boolean));

  const replaceHop = (index: number, value: string) => {
    setHops((current) => current.map((hop, at) => at === index ? value : hop));
  };

  const moveHop = (index: number, offset: number) => {
    setHops((current) => {
      const next = [...current];
      [next[index], next[index + offset]] = [next[index + offset], next[index]];
      return next;
    });
  };

  const apply = async () => {
    setBusy(true);
    setNote(null);
    setError(null);
    try {
      const state = await setUpstream(configured);
      load(state);
      setNote(msg('upstream.applied'));
    } catch (err) {
      setError(msg('upstream.failed', { message: (err as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h3>{t('upstream.section')}</h3>
      <p className="muted">{t('upstream.help')}</p>
      <div className="settings-row">
        <label htmlFor="upstream-mode">{t('upstream.mode')}</label>
        <select
          id="upstream-mode"
          value={enabled ? 'upstream' : 'direct'}
          disabled={busy}
          onChange={(event) => setEnabled(event.target.value === 'upstream')}
        >
          <option value="direct">{t('upstream.direct')}</option>
          <option value="upstream">{t('upstream.via')}</option>
        </select>
      </div>
      {enabled && (
        <div className="upstream-hops">
          {hops.map((hop, index) => (
            <div className="upstream-hop" key={index}>
              <label htmlFor={`upstream-hop-${index}`}>{t('upstream.hop', { number: index + 1 })}</label>
              <input
                id={`upstream-hop-${index}`}
                className="mono upstream-url"
                type="url"
                placeholder="http://127.0.0.1:8081"
                value={hop}
                disabled={busy}
                onChange={(event) => replaceHop(index, event.target.value)}
              />
              <button type="button" disabled={busy || index === 0} onClick={() => moveHop(index, -1)} aria-label={t('upstream.moveUp', { number: index + 1 })}>↑</button>
              <button type="button" disabled={busy || index === hops.length - 1} onClick={() => moveHop(index, 1)} aria-label={t('upstream.moveDown', { number: index + 1 })}>↓</button>
              <button type="button" disabled={busy || hops.length === 1} onClick={() => setHops((current) => current.filter((_, at) => at !== index))} aria-label={t('upstream.remove', { number: index + 1 })}>×</button>
            </div>
          ))}
          <button type="button" disabled={busy || hops.length >= 16} onClick={() => setHops((current) => [...current, ''])}>{t('upstream.add')}</button>
        </div>
      )}
      <div className="settings-row">
        <button type="button" disabled={busy || !changed || !valid} onClick={() => void apply()}>
          {t('upstream.apply')}
        </button>
      </div>
      {note && <p className="muted">{renderMessage(note, t)}</p>}
      {error && <div className="banner error">{renderMessage(error, t)}</div>}
    </section>
  );
}

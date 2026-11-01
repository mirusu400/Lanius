/** Ordered upstream proxy chain for the browser-facing listener. */

import { useEffect, useState } from 'react';

import { getUpstream, setUpstream } from '../../api/client';
import type { UpstreamAuthenticationInput, UpstreamState } from '../../api/types';
import { msg, rawMsg, renderMessage, useI18n, type Message } from '../../i18n';
import { UndoableInput } from '../../components/UndoableText';
import { useSettingsToast } from '../../components/useSettingsToast';

interface HopDraft {
  url: string;
  authEnabled: boolean;
  username: string;
  password: string;
  passwordSet: boolean;
  passwordChanged: boolean;
  savedUrl: string;
  savedUsername: string;
}

function blankHop(): HopDraft {
  return {
    url: '',
    authEnabled: false,
    username: '',
    password: '',
    passwordSet: false,
    passwordChanged: false,
    savedUrl: '',
    savedUsername: '',
  };
}

export function UpstreamSection() {
  const { t } = useI18n();
  const savedToast = useSettingsToast('upstream.section');
  const [saved, setSaved] = useState<UpstreamState | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [hops, setHops] = useState<HopDraft[]>([blankHop()]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Message | null>(null);
  const [error, setError] = useState<Message | null>(null);

  const load = (state: UpstreamState) => {
    const authentication = state.authentication ?? [];
    setSaved(state);
    setEnabled(state.enabled);
    setHops(state.hops.length ? state.hops.map((url, index) => {
      const auth = authentication[index] ?? null;
      return {
        url,
        authEnabled: auth !== null,
        username: auth?.username ?? '',
        password: '',
        passwordSet: auth?.password_set ?? false,
        passwordChanged: false,
        savedUrl: url,
        savedUsername: auth?.username ?? '',
      };
    }) : [blankHop()]);
  };

  useEffect(() => {
    getUpstream().then(load).catch((err) => setError(rawMsg((err as Error).message)));
  }, []);

  if (!saved) return error ? <section><div className="banner error">{renderMessage(error, t)}</div></section> : null;

  const configured = enabled ? hops.map((hop) => hop.url.trim()) : [];
  const authentication: (UpstreamAuthenticationInput | null)[] = enabled
    ? hops.map((hop) => {
      if (!hop.authEnabled) return null;
      return hop.passwordChanged
        ? { username: hop.username, password: hop.password }
        : { username: hop.username };
    })
    : [];
  const routeChanged = configured.length !== saved.hops.length
    || configured.some((hop, index) => hop !== saved.hops[index]);
  const authChanged = enabled && hops.some((hop, index) => {
    const savedAuth = saved.authentication?.[index] ?? null;
    return hop.authEnabled !== (savedAuth !== null)
      || (hop.authEnabled && (
        hop.username !== savedAuth?.username || hop.passwordChanged
      ));
  });
  const changed = routeChanged || authChanged;
  const valid = !enabled || (
    configured.length > 0
    && configured.every(Boolean)
    && hops.every((hop) => !hop.authEnabled || (
      Boolean(hop.username.trim())
      && (
        hop.passwordChanged
        || (
          hop.passwordSet
          && hop.url.trim() === hop.savedUrl
          && hop.username === hop.savedUsername
        )
      )
    ))
  );

  const replaceHop = (index: number, update: Partial<HopDraft>) => {
    setHops((current) => current.map((hop, at) => at === index ? { ...hop, ...update } : hop));
  };

  const toggleAuthentication = (index: number, checked: boolean) => {
    setHops((current) => current.map((hop, at) => {
      if (at !== index) return hop;
      return {
        ...hop,
        authEnabled: checked,
        passwordChanged: checked && !hop.passwordSet ? true : hop.passwordChanged,
      };
    }));
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
      const state = await setUpstream(configured, authentication);
      load(state);
      savedToast();
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
              <div className="upstream-hop-route">
                <label htmlFor={`upstream-hop-${index}`}>{t('upstream.hop', { number: index + 1 })}</label>
                <UndoableInput
                  id={`upstream-hop-${index}`}
                  className="mono upstream-url"
                  type="url"
                  placeholder="http://127.0.0.1:8081"
                  value={hop.url}
                  disabled={busy}
                  historyKey={`upstream-hop-${index}`}
                  onValueChange={(value) => replaceHop(index, { url: value })}
                />
                <button type="button" disabled={busy || index === 0} onClick={() => moveHop(index, -1)} aria-label={t('upstream.moveUp', { number: index + 1 })}>↑</button>
                <button type="button" disabled={busy || index === hops.length - 1} onClick={() => moveHop(index, 1)} aria-label={t('upstream.moveDown', { number: index + 1 })}>↓</button>
                <button type="button" disabled={busy || hops.length === 1} onClick={() => setHops((current) => current.filter((_, at) => at !== index))} aria-label={t('upstream.remove', { number: index + 1 })}>×</button>
              </div>
              <label className="upstream-auth-toggle">
                <input
                  type="checkbox"
                  checked={hop.authEnabled}
                  disabled={busy}
                  onChange={(event) => toggleAuthentication(index, event.target.checked)}
                />
                {t('upstream.authentication')}
              </label>
              {hop.authEnabled && (
                <div className="upstream-credentials">
                  <label htmlFor={`upstream-username-${index}`}>{t('upstream.username')}</label>
                  <UndoableInput
                    id={`upstream-username-${index}`}
                    type="text"
                    value={hop.username}
                    disabled={busy}
                    autoComplete="off"
                    historyKey={`upstream-username-${index}`}
                    onValueChange={(value) => replaceHop(index, { username: value })}
                  />
                  <label htmlFor={`upstream-password-${index}`}>{t('upstream.password')}</label>
                  <input
                    id={`upstream-password-${index}`}
                    type="password"
                    value={hop.password}
                    disabled={busy}
                    autoComplete="off"
                    placeholder={hop.passwordSet ? t('upstream.passwordSaved') : ''}
                    onChange={(event) => replaceHop(index, {
                      password: event.target.value,
                      passwordChanged: true,
                    })}
                  />
                  {hop.passwordSet && !hop.passwordChanged && (
                    <span className="muted upstream-password-hint">{t('upstream.passwordHint')}</span>
                  )}
                </div>
              )}
            </div>
          ))}
          <button type="button" disabled={busy || hops.length >= 16} onClick={() => setHops((current) => [...current, blankHop()])}>{t('upstream.add')}</button>
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

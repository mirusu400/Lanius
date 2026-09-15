/** Which client the proxy looks like on the wire. */

import { useEffect, useState } from 'react';
import {
  getTlsState,
  setTlsProfile,
} from '../../api/client';
import type { TlsState } from '../../api/types';
import {
  msg,
  rawMsg,
  renderMessage,
  useI18n,
  type Message,
} from '../../i18n';

/** Reshapes the handshake Lanius makes towards the server. */
export function TlsSection() {
  const { t } = useI18n();
  const [state, setState] = useState<TlsState | null>(null);
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Message | null>(null);
  const [error, setError] = useState<Message | null>(null);

  useEffect(() => {
    getTlsState()
      .then((next) => {
        // Guard the shape: rendering maps over `available`, so a response
        // without it would take the whole Settings tab down.
        if (!next || !Array.isArray(next.available)) return;
        setState(next);
        setCustom(next.custom_ciphers ?? '');
      })
      .catch(() => undefined);
  }, []);

  const apply = async (profile: string, ciphers: string) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const next = await setTlsProfile(profile, ciphers);
      if (next && Array.isArray(next.available)) {
        setState(next);
        setCustom(next.custom_ciphers ?? '');
      }
      setNote(msg('tls.applied'));
    } catch (err) {
      setError(rawMsg((err as Error).message));
    } finally {
      setBusy(false);
    }
  };

  if (!state) return null;

  // The count is what actually reaches the server, so it is the useful
  // confirmation that a profile took effect.
  const cipherCount = state.ciphers ? state.ciphers.split(':').length : 0;

  return (
    <section>
      <h3>{t('tls.section')}</h3>
      <p className="muted">{t('tls.help')}</p>

      <div className="row tls-row">
        <label htmlFor="tls-profile">{t('tls.profile')}</label>
        <select
          id="tls-profile"
          value={state.profile}
          disabled={busy}
          onChange={(e) => void apply(e.target.value, custom)}
        >
          {state.available.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        {cipherCount > 0 && (
          <span className="muted">
            {t('tls.active', { count: String(cipherCount) })}
          </span>
        )}
      </div>

      <div className="tls-custom">
        <label htmlFor="tls-ciphers">{t('tls.customLabel')}</label>
        <div className="row">
          <input
            id="tls-ciphers"
            className="mono"
            value={custom}
            disabled={busy}
            placeholder={t('tls.customPlaceholder')}
            onChange={(e) => setCustom(e.target.value)}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => void apply(state.profile, custom)}
          >
            {t('tls.apply')}
          </button>
        </div>
      </div>

      {note && <p className="muted">{renderMessage(note, t)}</p>}
      {error && <div className="banner error">{renderMessage(error, t)}</div>}
      <p className="muted">{t('tls.limitation')}</p>
    </section>
  );
}

/** Export and import, plus a reminder that work is saved as you go. */

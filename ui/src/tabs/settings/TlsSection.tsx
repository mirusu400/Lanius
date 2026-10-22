/** Which client the proxy looks like on the wire. */

import { useEffect, useState } from 'react';
import { useSettingsToast } from '../../components/useSettingsToast';
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
import { UndoableInput } from '../../components/UndoableText';

/** Reshapes the handshake Lanius makes towards the server. */
export function TlsSection() {
  const { t } = useI18n();
  const saved = useSettingsToast('tls.section');
  const [state, setState] = useState<TlsState | null>(null);
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState<Message | null>(null);
  const [error, setError] = useState<Message | null>(null);

  useEffect(() => {
    getTlsState()
      .then((next) => {
        // Rendering maps over `available`, so reject an incomplete response
        // as a recoverable error instead of taking Settings down.
        if (!next || !Array.isArray(next.available)) {
          setError(msg('tls.invalidResponse'));
          return;
        }
        setState(next);
        setCustom(next.custom_ciphers ?? '');
      })
      .catch((err) => setError(msg('tls.loadFailed', { message: (err as Error).message })))
      .finally(() => setLoading(false));
  }, []);

  const retry = async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await getTlsState();
      if (!next || !Array.isArray(next.available)) {
        setError(msg('tls.invalidResponse'));
        return;
      }
      setState(next);
      setCustom(next.custom_ciphers ?? '');
    } catch (err) {
      setError(msg('tls.loadFailed', { message: (err as Error).message }));
    } finally {
      setLoading(false);
    }
  };

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
      saved();
    } catch (err) {
      setError(rawMsg((err as Error).message));
    } finally {
      setBusy(false);
    }
  };

  if (!state) {
    return (
      <section>
        <h3>{t('tls.section')}</h3>
        <p className="muted">{t('tls.help')}</p>
        {loading ? (
          <p className="muted" role="status">{t('common.loading')}</p>
        ) : (
          <div className="settings-load-error">
            {error && <div className="banner error">{renderMessage(error, t)}</div>}
            <button type="button" onClick={() => void retry()}>{t('common.retry')}</button>
          </div>
        )}
      </section>
    );
  }

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
          <UndoableInput
            id="tls-ciphers"
            className="mono"
            value={custom}
            disabled={busy}
            placeholder={t('tls.customPlaceholder')}
            onValueChange={setCustom}
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

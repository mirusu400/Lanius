/** Which client the proxy looks like on the wire. */

import { useEffect, useMemo, useState } from 'react';
import { useSettingsToast } from '../../components/useSettingsToast';
import {
  getTlsState,
  setTlsProfile,
} from '../../api/client';
import type { TlsCipherOption, TlsState } from '../../api/types';
import {
  msg,
  rawMsg,
  renderMessage,
  useI18n,
  type Message,
} from '../../i18n';

function completeState(state: TlsState): boolean {
  return Array.isArray(state.available)
    && Array.isArray(state.selected_ciphers)
    && Array.isArray(state.supported_ciphers)
    && Array.isArray(state.tls13_ciphers);
}

/** Reshapes the handshake Lanius makes towards the server. */
export function TlsSection() {
  const { t } = useI18n();
  const saved = useSettingsToast('tls.section');
  const [state, setState] = useState<TlsState | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState<Message | null>(null);
  const [error, setError] = useState<Message | null>(null);
  const byName = useMemo(
    () => new Map((state?.supported_ciphers ?? []).map((cipher) => [cipher.name, cipher])),
    [state?.supported_ciphers],
  );

  useEffect(() => {
    getTlsState()
      .then((next) => {
        // Rendering maps over `available`, so reject an incomplete response
        // as a recoverable error instead of taking Settings down.
        if (!next || !completeState(next)) {
          setError(msg('tls.invalidResponse'));
          return;
        }
        setState(next);
        setSelected(next.selected_ciphers);
      })
      .catch((err) => setError(msg('tls.loadFailed', { message: (err as Error).message })))
      .finally(() => setLoading(false));
  }, []);

  const retry = async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await getTlsState();
      if (!next || !completeState(next)) {
        setError(msg('tls.invalidResponse'));
        return;
      }
      setState(next);
      setSelected(next.selected_ciphers);
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
      if (next && completeState(next)) {
        setState(next);
        setSelected(next.selected_ciphers);
      } else {
        setError(msg('tls.invalidResponse'));
        return;
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
  const cipherCount = state.selected_ciphers.length + state.tls13_ciphers.length;
  const selectedKey = selected.join('\u0000');
  const savedKey = state.selected_ciphers.join('\u0000');
  const dirty = selectedKey !== savedKey;
  const available = state.supported_ciphers.filter((cipher) =>
    !selected.includes(cipher.name)
      && (showAll || cipher.recommended)
      && cipher.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );

  const changeSelected = (next: string[]) => {
    setSelected(next);
    setNote(null);
    setError(null);
  };
  const removeCipher = (name: string) => changeSelected(selected.filter((item) => item !== name));
  const addCipher = (name: string) => changeSelected([...selected, name]);
  const moveCipher = (index: number, offset: -1 | 1) => {
    const target = index + offset;
    if (target < 0 || target >= selected.length) return;
    const next = [...selected];
    [next[index], next[target]] = [next[target], next[index]];
    changeSelected(next);
  };
  const cipherMeta = (name: string): TlsCipherOption | undefined => byName.get(name);

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
          onChange={(event) => void apply(
            event.target.value,
            dirty || state.custom_ciphers ? selected.join(':') : '',
          )}
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
        <div className="tls-cipher-heading">
          <div>
            <h4>{t('tls.customLabel')}</h4>
            <span className={`tls-cipher-mode ${state.custom_ciphers ? 'custom' : ''}`}>
              {t(state.custom_ciphers ? 'tls.customActive' : 'tls.profileDefaults')}
            </span>
          </div>
          <button
            type="button"
            disabled={busy || !state.custom_ciphers}
            onClick={() => void apply(state.profile, '')}
          >
            {t('tls.useProfileDefaults')}
          </button>
        </div>
        <p className="muted">{t('tls.cipherHelp')}</p>

        <div className="tls-cipher-manager">
          <div className="tls-cipher-column">
            <h5>{t('tls.selectedCiphers', { count: String(selected.length) })}</h5>
            <div className="tls-cipher-list" role="list" aria-label={t('tls.selectedList')}>
              {selected.length === 0 && <p className="muted">{t('tls.noCiphersSelected')}</p>}
              {selected.map((name, index) => {
                const meta = cipherMeta(name);
                return (
                  <div className="tls-cipher-item" role="listitem" key={name}>
                    <div className="tls-cipher-details">
                      <code>{name}</code>
                      {meta && <small>{meta.protocol} · {meta.strength_bits} bit</small>}
                    </div>
                    <div className="tls-cipher-controls">
                      <button type="button" disabled={busy || index === 0}
                        aria-label={t('tls.moveCipherUp', { cipher: name })}
                        onClick={() => moveCipher(index, -1)}>↑</button>
                      <button type="button" disabled={busy || index === selected.length - 1}
                        aria-label={t('tls.moveCipherDown', { cipher: name })}
                        onClick={() => moveCipher(index, 1)}>↓</button>
                      <button type="button" disabled={busy}
                        aria-label={t('tls.removeCipher', { cipher: name })}
                        onClick={() => removeCipher(name)}>−</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="tls-cipher-column">
            <div className="tls-cipher-available-heading">
              <h5>{t('tls.availableCiphers')}</h5>
              <span>{available.length}</span>
            </div>
            <label className="tls-cipher-show-all">
              <input type="checkbox" checked={showAll} disabled={busy}
                onChange={(event) => setShowAll(event.target.checked)} />
              {t('tls.showAllCiphers')}
            </label>
            <input type="search" value={query} disabled={busy}
              aria-label={t('tls.searchCiphers')}
              placeholder={t('tls.searchCiphers')}
              onChange={(event) => setQuery(event.target.value)} />
            <div className="tls-cipher-list available" role="list" aria-label={t('tls.availableList')}>
              {available.length === 0 && <p className="muted">{t('tls.noAvailableCiphers')}</p>}
              {available.map((cipher) => (
                <div role="listitem" key={cipher.name}>
                  <button type="button" className="tls-cipher-item tls-cipher-add"
                    disabled={busy}
                    aria-label={t('tls.addCipher', { cipher: cipher.name })}
                    onClick={() => addCipher(cipher.name)}>
                    <span aria-hidden="true">+</span>
                    <span className="tls-cipher-details">
                      <code>{cipher.name}</code>
                      <small>{cipher.protocol} · {cipher.strength_bits} bit</small>
                    </span>
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="tls-cipher-actions">
          <span className="muted">{dirty ? t('tls.unsavedOrder') : t('tls.savedOrder')}</span>
          <button type="button" disabled={busy || !dirty || selected.length === 0}
            onClick={() => void apply(state.profile, selected.join(':'))}>
            {t('tls.apply')}
          </button>
        </div>
        {state.tls13_ciphers.length > 0 && (
          <p className="muted tls-cipher-fixed">
            {t('tls.fixedTls13', { count: String(state.tls13_ciphers.length) })}
          </p>
        )}
      </div>

      {note && <p className="muted">{renderMessage(note, t)}</p>}
      {error && <div className="banner error">{renderMessage(error, t)}</div>}
      <p className="muted">{t('tls.limitation')}</p>
    </section>
  );
}

/** Export and import, plus a reminder that work is saved as you go. */

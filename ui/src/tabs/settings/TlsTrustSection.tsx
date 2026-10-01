/** Additional CA trust for origins reached through a VPN or private PKI. */

import { useEffect, useState } from 'react';
import { getTlsTrust, setTlsTrust } from '../../api/client';
import type { TlsTrustState } from '../../api/types';
import { msg, rawMsg, renderMessage, useI18n, type Message } from '../../i18n';

export function TlsTrustSection() {
  const { t } = useI18n();
  const [saved, setSaved] = useState<TlsTrustState | null>(null);
  const [pem, setPem] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Message | null>(null);
  const [error, setError] = useState<Message | null>(null);

  useEffect(() => {
    getTlsTrust().then((state) => {
      if (state && Array.isArray(state.certificates)) setSaved(state);
    }).catch((err) => setError(rawMsg((err as Error).message)));
  }, []);

  const apply = async (value: string) => {
    setBusy(true);
    setNote(null);
    setError(null);
    try {
      setSaved(await setTlsTrust(value));
      setPem('');
      setNote(msg(value.trim() ? 'tlsTrust.applied' : 'tlsTrust.removed'));
    } catch (err) {
      setError(rawMsg((err as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const loadFile = async (file: File) => {
    setError(null);
    setNote(null);
    if (file.size > 128 * 1024) {
      setError(msg('tlsTrust.tooLarge'));
      return;
    }
    setBusy(true);
    try {
      setPem(await file.text());
    } catch (err) {
      setError(rawMsg((err as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h3>{t('tlsTrust.section')}</h3>
      <p className="muted">{t('tlsTrust.help')}</p>
      {saved?.system_trust === 'macos' && <p className="muted">{t('tlsTrust.macos')}</p>}
      {saved && (saved.certificates.length ? saved.certificates.map((cert) => (
        <dl className="settings-grid" key={cert.sha256}>
          <dt>{t('tlsTrust.subject')}</dt><dd>{cert.subject}</dd>
          <dt>{t('tlsTrust.expires')}</dt><dd>{cert.expires_at.slice(0, 10)}{!cert.valid && ` · ${t('tlsTrust.invalidDate')}`}</dd>
          <dt>SHA-256</dt><dd className="mono">{cert.sha256}</dd>
        </dl>
      )) : <p className="muted">{t('tlsTrust.default')}</p>)}
      <div className="settings-row">
        <label className="import-button">
          {t('tlsTrust.import')}
          <input type="file" accept=".pem,.crt,.cer" aria-label={t('tlsTrust.import')}
            disabled={busy || !saved} onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void loadFile(file);
              event.target.value = '';
            }} />
        </label>
      </div>
      <div className="tls-trust-pem">
        <label htmlFor="tls-trust-pem">{t('tlsTrust.pem')}</label>
        <textarea id="tls-trust-pem" className="mono" rows={5} value={pem}
          disabled={busy || !saved} placeholder="-----BEGIN CERTIFICATE-----"
          onChange={(event) => setPem(event.target.value)} />
      </div>
      <div className="settings-row">
        <button type="button" disabled={busy || !saved || !pem.trim()} onClick={() => void apply(pem)}>{t('tlsTrust.apply')}</button>
        <button type="button" disabled={busy || !saved?.certificates.length} onClick={() => void apply('')}>{t('tlsTrust.remove')}</button>
      </div>
      <p className="muted">{t('tlsTrust.restart')}</p>
      {note && <p className="muted" role="status">{renderMessage(note, t)}</p>}
      {error && <div className="banner error" role="alert">{renderMessage(error, t)}</div>}
    </section>
  );
}

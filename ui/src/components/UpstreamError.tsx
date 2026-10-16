/** Why a request got no response, with a way past a known-bad certificate. */

import { useState } from 'react';

import { addTlsException } from '../api/client';
import { useT } from '../i18n';
import { ConfirmDialog } from './ConfirmDialog';

/** mitmproxy's wording for a failed upstream certificate verification. */
export const TLS_VERIFY_PREFIX = 'Certificate verify failed:';

export function UpstreamError({ error, host, hasResponse }: {
  error: string | null | undefined;
  host: string | null | undefined;
  hasResponse: boolean;
}) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  if (!error) return null;

  const tlsVerify = error.startsWith(TLS_VERIFY_PREFIX);
  const allow = async () => {
    if (!host) return;
    setConfirming(false);
    setBusy(true);
    setFailure(null);
    try {
      await addTlsException(host);
      setAdded(host);
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="banner error upstream-error" role="alert">
      <div>
        <strong>{tlsVerify ? t('detail.tlsVerifyFailed') : hasResponse ? t('detail.flowError') : t('detail.noResponse')}</strong>
        <span className="mono">{error}</span>
        {tlsVerify && !added && <span>{t('detail.tlsVerifyHelp')}</span>}
        {added && <span role="status">{t('detail.tlsExceptionAdded', { host: added })}</span>}
        {failure && <span>{failure}</span>}
      </div>
      {tlsVerify && host && !added && <button type="button" disabled={busy} onClick={() => setConfirming(true)}>
        {t('detail.allowHost')}
      </button>}
      <ConfirmDialog
        open={confirming}
        title={t('detail.allowHostTitle')}
        message={t('detail.allowHostMessage', { host: host ?? '' })}
        confirmLabel={t('detail.allowHostConfirm')}
        onConfirm={() => void allow()}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}

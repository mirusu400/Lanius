import { useEffect, useState } from 'react';

import { getStatus } from '../api/client';
import { useEngineConnection } from '../engineConnection';
import { useT } from '../i18n';

const RETRY_INTERVAL_MS = 2_000;

/** One persistent explanation replaces the same fetch error from every pane. */
export function EngineConnectionBanner() {
  const t = useT();
  const connection = useEngineConnection();
  const [checking, setChecking] = useState(false);

  const retry = async () => {
    if (checking) return;
    setChecking(true);
    try {
      await getStatus();
    } catch {
      // apiFetch keeps the shared state offline and preserves the reason.
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    if (connection.status !== 'offline') return;
    const timer = window.setInterval(() => void getStatus().catch(() => undefined), RETRY_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [connection.status]);

  if (connection.status !== 'offline') return null;
  return (
    <div className="engine-connection-banner" role="alert">
      <div>
        <strong>{t('engine.connectionLost')}</strong>
        <span>{t('engine.connectionHelp')}</span>
      </div>
      <button type="button" disabled={checking} onClick={() => void retry()}>
        {checking ? t('engine.connectionChecking') : t('engine.connectionRetry')}
      </button>
    </div>
  );
}

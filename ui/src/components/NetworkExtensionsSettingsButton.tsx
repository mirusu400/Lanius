import { useState } from 'react';

import {
  canOpenNetworkExtensionsSettings,
  openNetworkExtensionsSettings,
} from '../api/client';
import { useT } from '../i18n';

/** Shown only with the macOS approval warning, which is desktop-only. */
export function NetworkExtensionsSettingsButton() {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!canOpenNetworkExtensionsSettings()) return null;

  const open = async () => {
    setError(null);
    setBusy(true);
    try {
      await openNetworkExtensionsSettings();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return <>
    <button className="network-extension-settings-button" type="button" disabled={busy} onClick={() => void open()}>
      {t('capture.openNetworkExtensions')}
    </button>
    {error && <div className="field-error" role="alert">
      {t('capture.openSettingsFailed', { message: error })}
    </div>}
  </>;
}

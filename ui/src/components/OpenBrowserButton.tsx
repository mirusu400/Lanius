/** Opens a browser that is already pointed at the proxy.
 *
 * Sits next to the history because that is where a user decides they want
 * traffic to look at, rather than buried in Settings.
 */
import { useEffect, useState } from 'react';

import { getBrowserState, openBrowser } from '../api/client';
import type { BrowserState } from '../api/types';
import { useT } from '../i18n';

export function OpenBrowserButton() {
  const t = useT();
  const [state, setState] = useState<BrowserState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getBrowserState()
      .then(setState)
      .catch(() => setState(null));
  }, []);

  // Nothing to offer if no browser is installed, and a dead button would
  // be worse than none: the title says why it cannot be used.
  const unavailable = state !== null && !state.available;

  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      await openBrowser();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        disabled={busy || unavailable}
        title={
          unavailable
            ? t('browser.unavailable')
            : error
              ? t('browser.failed', { message: error })
              : t('browser.help')
        }
        onClick={() => void open()}
      >
        {busy ? t('browser.opening') : t('browser.open')}
      </button>
    </>
  );
}

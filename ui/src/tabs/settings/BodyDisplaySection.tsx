import { useEffect, useState } from 'react';

import {
  getBodyDisplaySettings,
  setBodyDisplaySettings,
} from '../../api/client';
import { useT } from '../../i18n';

export function BodyDisplaySection() {
  const t = useT();
  const [enabled, setEnabled] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getBodyDisplaySettings()
      .then((state) => setEnabled(state.auto_decompress))
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, []);

  const update = async (next: boolean) => {
    setEnabled(next);
    setBusy(true);
    try {
      const state = await setBodyDisplaySettings(next);
      setEnabled(state.auto_decompress);
    } catch {
      setEnabled(!next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h3>{t('bodyDisplay.section')}</h3>
      <p className="muted">{t('bodyDisplay.help')}</p>
      <div className="settings-row">
        <label>
          <input
            type="checkbox"
            checked={enabled}
            disabled={!loaded || busy}
            onChange={(event) => void update(event.target.checked)}
          />{' '}
          {t('bodyDisplay.autoDecompress')}
        </label>
      </div>
    </section>
  );
}

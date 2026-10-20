import { useEffect, useState } from 'react';

import {
  getBodyDisplaySettings,
  setBodyDisplaySettings,
} from '../../api/client';
import { useT } from '../../i18n';
import { useToast } from '../../components/Toast';
import { useSettingsToast } from '../../components/useSettingsToast';

export function BodyDisplaySection() {
  const t = useT();
  const saved = useSettingsToast('bodyDisplay.section');
  const { showToast } = useToast();
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
      saved();
    } catch (error) {
      setEnabled(!next);
      showToast({ message: `${t('bodyDisplay.section')}: ${(error as Error).message}`, tone: 'error' });
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

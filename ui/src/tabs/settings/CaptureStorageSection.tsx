import { useEffect, useState } from 'react';
import { getCaptureStorageSettings, setCaptureStorageSettings } from '../../api/client';
import { useT } from '../../i18n';

export function CaptureStorageSection() {
  const t = useT();
  const [value, setValue] = useState('5');
  const [saved, setSaved] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getCaptureStorageSettings().then((state) => {
      setSaved(state.media_body_limit_mb);
      setValue(String(state.media_body_limit_mb));
    }).catch((err: Error) => setError(err.message));
  }, []);
  const limit = Number(value);
  const valid = value.trim() !== '' && Number.isInteger(limit) && limit >= 0 && limit <= 1024;
  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const state = await setCaptureStorageSettings(limit);
      setSaved(state.media_body_limit_mb);
      setValue(String(state.media_body_limit_mb));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return <section>
    <h3>{t('captureStorage.section')}</h3>
    <p className="muted">{t('captureStorage.help')}</p>
    <div className="settings-row">
      <label>{t('captureStorage.limit')} <input type="number" min={0} max={1024} step={1}
        value={value} disabled={saved === null || busy} onChange={(event) => setValue(event.target.value)} /></label>
      <button type="button" disabled={saved === null || busy || !valid || limit === saved} onClick={() => void apply()}>{t('captureStorage.apply')}</button>
    </div>
    <p className="muted">{t('captureStorage.hint')}</p>
    {error && <div className="banner error" role="alert">{error}</div>}
  </section>;
}

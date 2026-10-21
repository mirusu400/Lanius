import { useEffect, useState } from 'react';
import { getHttpProtocol, setHttpProtocol } from '../../api/client';
import type { HttpMode } from '../../api/types';
import { useT } from '../../i18n';
import { useToast } from '../../components/Toast';
import { useSettingsToast } from '../../components/useSettingsToast';
import { HttpModeSelect } from '../../components/HttpModeSelect';

export function HttpProtocolSection() {
  const t = useT();
  const saved = useSettingsToast('httpProtocol.section');
  const { showToast } = useToast();
  const [mode, setMode] = useState<HttpMode>('auto');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    getHttpProtocol().then((state) => { setMode(state.mode); setLoaded(true); })
      .catch((error: Error) => showToast({ message: error.message, tone: 'error' }));
  }, [showToast]);
  const update = async (next: HttpMode | null) => {
    if (!next) return;
    setBusy(true);
    try { setMode((await setHttpProtocol(next)).mode); saved(); }
    catch (error) { showToast({ message: (error as Error).message, tone: 'error' }); }
    finally { setBusy(false); }
  };
  return <section>
    <h3>{t('httpProtocol.section')}</h3>
    <p className="muted">{t('httpProtocol.help')}</p>
    <div className="settings-row"><HttpModeSelect value={mode} onChange={(next) => void update(next)}
      inherit={false} disabled={!loaded || busy} /></div>
  </section>;
}

import { useState, useSyncExternalStore } from 'react';
import { DEFAULT_DOCUMENT_CACHE_MIB, MAX_DOCUMENT_CACHE_MIB, textDocumentCache } from '../../components/textDocumentCache';
import { UndoableInput } from '../../components/UndoableText';
import { useSettingsToast } from '../../components/useSettingsToast';
import { useT } from '../../i18n';
import { flushAutosaves } from '../autosave';

export function DocumentCacheSection() {
  const t = useT();
  const savedToast = useSettingsToast('documentCache.section');
  const stats = useSyncExternalStore(textDocumentCache.subscribe, textDocumentCache.getSnapshot);
  const limitMiB = stats.maxBytes / (1024 * 1024);
  const [draft, setDraft] = useState<{ limit: number; value: string } | null>(null);
  const value = draft?.limit === limitMiB ? draft.value : String(limitMiB);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = Number(value);
  const valid = value.trim() !== '' && Number.isInteger(next) && next >= 0 && next <= MAX_DOCUMENT_CACHE_MIB;
  const apply = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      textDocumentCache.setLimitMiB(next);
      await flushAutosaves();
      savedToast();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };

  return <section>
    <h3>{t('documentCache.section')}</h3>
    <p className="muted">{t('documentCache.help')}</p>
    <div className="settings-row">
      <label>{t('documentCache.limit')} <UndoableInput type="number" min={0} max={MAX_DOCUMENT_CACHE_MIB} step={1}
        value={value} disabled={busy} onValueChange={value => setDraft({ limit: limitMiB, value })} /></label>
      <button type="button" disabled={busy || !valid || (next === limitMiB && !error)} onClick={() => void apply()}>{t('documentCache.apply')}</button>
    </div>
    <p className="muted">{t('documentCache.hint', { default: DEFAULT_DOCUMENT_CACHE_MIB, max: MAX_DOCUMENT_CACHE_MIB })}</p>
    <p className="muted" role="status">{t('documentCache.usage', { size: (stats.bytes / (1024 * 1024)).toFixed(2), count: stats.count })}</p>
    <div className="settings-row">
      <button type="button" onClick={() => textDocumentCache.clear()}>{t('documentCache.clear')}</button>
    </div>
    {error && <div className="banner error" role="alert">{error}</div>}
  </section>;
}

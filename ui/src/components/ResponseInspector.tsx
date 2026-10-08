import { useEffect, useState } from 'react';

import { getFlow } from '../api/client';
import { useT } from '../i18n';
import { rawResponse } from './rawHttp';
import { ResponsePreview } from './ResponsePreview';
import { formatBytes } from '../tabs/proxyModel';

/** The same recorded response can be inspected from Replay or Fuzzer.
 * Replay already has raw text; Fuzzer retrieves it from its result flow.
 */
export function ResponseInspector({
  flowId,
  raw,
  bodyOmitted,
  bodySize,
  title,
  empty,
}: {
  flowId: string | null;
  raw?: string;
  bodyOmitted?: boolean;
  bodySize?: number;
  title?: string;
  empty: string;
}) {
  const t = useT();
  const [view, setView] = useState<'raw' | 'preview'>('raw');
  const [loaded, setLoaded] = useState<{ flowId: string; raw?: string; error?: string; bodyOmitted?: boolean; bodySize?: number } | null>(null);

  useEffect(() => {
    if (!flowId || raw !== undefined) return;
    let cancelled = false;
    getFlow(flowId)
      .then((detail) => {
        if (!cancelled) setLoaded({ flowId, raw: rawResponse(detail, detail), bodyOmitted: detail.response_body_omitted, bodySize: detail.response_size });
      })
      .catch((cause: unknown) => {
        if (!cancelled) setLoaded({ flowId, error: cause instanceof Error ? cause.message : String(cause) });
      });
    return () => { cancelled = true; };
  }, [flowId, raw]);

  const rawText = raw ?? (loaded?.flowId === flowId ? loaded.raw : undefined);
  const error = loaded?.flowId === flowId ? loaded.error : undefined;
  const omitted = bodyOmitted ?? (loaded?.flowId === flowId ? loaded.bodyOmitted : false);
  const size = bodySize ?? (loaded?.flowId === flowId ? loaded.bodySize : 0);

  return <section className="response-inspector">
    <div className="response-inspector-bar">
      <span className="detail-half-title">{title ?? t('detail.response')}</span>
      {flowId && <div className="view-switch" role="tablist">
        <button type="button" role="tab" aria-selected={view === 'raw'} className={view === 'raw' ? 'active' : ''} onClick={() => setView('raw')}>{t('detail.view.raw')}</button>
        <button type="button" role="tab" aria-selected={view === 'preview'} className={view === 'preview' ? 'active' : ''} onClick={() => setView('preview')}>{t('detail.view.preview')}</button>
      </div>}
    </div>
    <div className="response-inspector-body">
      {omitted && <p className="banner" role="status">{t('detail.mediaBodyOmitted', { size: formatBytes(size ?? 0) })}</p>}
      {!flowId ? <p className="muted">{empty}</p> : view === 'preview'
        ? !omitted && <ResponsePreview flowId={flowId} />
        : error ? <p className="banner error">{error}</p>
          : rawText === undefined ? <p className="muted">{t('detail.preview.loading')}</p>
            : <pre className="replay-response mono">{rawText}</pre>}
    </div>
  </section>;
}

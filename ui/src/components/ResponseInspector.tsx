import { useEffect, useState } from 'react';

import { getFlow } from '../api/client';
import { useT } from '../i18n';
import { rawResponse } from './rawHttp';
import { ResponsePreview } from './ResponsePreview';
import { formatBytes } from '../tabs/proxyModel';
import { HighlightedMessage } from './SyntaxCode';
import { messageHeaders } from './syntaxLanguage';
import { formatMessageBody, type BodyView } from './bodyFormat';
import { CodeDisplayControls } from './CodeDisplayControls';
import { LoadingPane } from './Spinner';
import { RawHexView } from './RawHexView';

type View = BodyView | 'preview';
const VIEWS: View[] = ['pretty', 'raw', 'hex', 'preview'];

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
  const [view, setView] = useState<View>('pretty');
  const [showLineEndings, setShowLineEndings] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [loaded, setLoaded] = useState<{ flowId: string; raw?: string; error?: string; bodyOmitted?: boolean; bodySize?: number; bodyCapturedSize?: number } | null>(null);

  useEffect(() => {
    if (!flowId || raw !== undefined) return;
    let cancelled = false;
    const controller = new AbortController();
    getFlow(flowId, false, {}, controller.signal)
      .then((detail) => {
        if (!cancelled) setLoaded({
          flowId,
          raw: rawResponse(detail, detail),
          bodyOmitted: detail.response_body_omitted,
          bodySize: detail.response_size,
          bodyCapturedSize: detail.response_body_captured_size,
        });
      })
      .catch((cause: unknown) => {
        if (!cancelled) setLoaded({ flowId, error: cause instanceof Error ? cause.message : String(cause) });
      });
    return () => { cancelled = true; controller.abort(); };
  }, [flowId, raw]);

  const rawText = raw ?? (loaded?.flowId === flowId ? loaded.raw : undefined);
  const error = loaded?.flowId === flowId ? loaded.error : undefined;
  const omitted = bodyOmitted ?? (loaded?.flowId === flowId ? loaded.bodyOmitted : false);
  const size = bodySize ?? (loaded?.flowId === flowId ? loaded.bodySize : 0);
  const capturedSize = loaded?.flowId === flowId ? loaded.bodyCapturedSize : undefined;
  const shown = view === 'pretty' && rawText !== undefined
    ? formatMessageBody(rawText, 'pretty')
    : rawText;

  return <section className="response-inspector">
    <div className="response-inspector-bar">
      <span className="detail-half-title">{title ?? t('detail.response')}</span>
      {flowId && <CodeDisplayControls showLineEndings={showLineEndings} onShowLineEndings={setShowLineEndings}
        wrap={wrap} onWrap={setWrap} disabled={view === 'preview' || view === 'hex'} />}
      {flowId && <div className="view-switch" role="tablist">
        {VIEWS.map((option) => <button
          key={option}
          type="button"
          role="tab"
          aria-selected={view === option}
          className={view === option ? 'active' : ''}
          onClick={() => setView(option)}
        >
          {t(`detail.view.${option === 'pretty' ? 'parsed' : option}`)}
        </button>)}
      </div>}
    </div>
    <div className="response-inspector-body">
      {omitted && <p className="banner" role="status">{t('detail.mediaBodyOmitted', { size: formatBytes(size ?? 0) })}</p>}
      {!flowId ? <p className="muted">{empty}</p> : view === 'preview'
        ? !omitted && <ResponsePreview flowId={flowId} />
        : error ? <p className="banner error">{error}</p>
          : rawText === undefined ? <LoadingPane label={t('detail.preview.loading')} />
            : view === 'hex'
              ? <RawHexView
                  flowId={raw === undefined ? flowId : undefined}
                  side={raw === undefined ? 'response' : undefined}
                  raw={rawText}
                  http
                  bodyBytes={capturedSize ?? size}
                  bodyOmitted={omitted}
                  className="replay-response mono"
                />
              : <HighlightedMessage className="replay-response mono" text={shown ?? ''} headers={messageHeaders(rawText)} showLineEndings={showLineEndings} wrap={wrap} />}
    </div>
  </section>;
}

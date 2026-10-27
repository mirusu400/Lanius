import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

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
import { matchCount } from './searchHighlight';
import { MessageSearchBar, MessageSearchToggles } from './MessageSearch';

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
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [previewMatches, setPreviewMatches] = useState(0);
  const [hexMatches, setHexMatches] = useState(0);
  const sectionRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
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
  const query = findOpen ? findQuery : '';
  const matches = !query ? 0
    : view === 'hex' ? hexMatches
      : view === 'preview' ? previewMatches
        : matchCount(shown ?? '', query);
  const currentIndex = matches ? activeIndex % matches : 0;

  const openFind = useCallback(() => {
    if (findOpen) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else {
      setActiveIndex(0);
      setFindOpen(true);
    }
  }, [findOpen]);

  useEffect(() => {
    if (!findOpen) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [findOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const inside = target instanceof Node && !!sectionRef.current?.contains(target);
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        if (event.defaultPrevented || !inside) return;
        event.preventDefault();
        openFind();
      } else if (event.key === 'Escape' && findOpen && inside) {
        event.preventDefault();
        setFindOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [findOpen, openFind]);

  useLayoutEffect(() => {
    if (!findOpen || !query || !matches) return;
    const mark = sectionRef.current?.querySelector<HTMLElement>(`.response-inspector-body mark[data-find-index="${currentIndex}"]`);
    mark?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [currentIndex, findOpen, matches, query, view]);

  const move = (direction: number) => {
    if (matches) setActiveIndex((currentIndex + direction + matches) % matches);
  };

  return <section className="response-inspector" ref={sectionRef}>
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
          onClick={() => {
            setView(option);
            setActiveIndex(0);
            if (option === 'preview') setPreviewMatches(0);
            if (option === 'hex') setHexMatches(0);
          }}
        >
          {t(`detail.view.${option === 'pretty' ? 'parsed' : option}`)}
        </button>)}
      </div>}
      {flowId && <MessageSearchToggles pane={title ?? t('detail.response')} mode={findOpen ? 'find' : null} onFind={openFind} />}
    </div>
    {findOpen && <MessageSearchBar
      pane={title ?? t('detail.response')}
      mode="find"
      query={findQuery}
      inputRef={inputRef}
      current={currentIndex}
      count={matches}
      onQuery={(next) => { setFindQuery(next); setActiveIndex(0); }}
      onPrevious={() => move(-1)}
      onNext={() => move(1)}
      onClose={() => setFindOpen(false)}
    />}
    <div className="response-inspector-body">
      {omitted && <p className="banner" role="status">{t('detail.mediaBodyOmitted', { size: formatBytes(size ?? 0) })}</p>}
      {!flowId ? <p className="muted">{empty}</p> : view === 'preview'
        ? !omitted && <ResponsePreview flowId={flowId} query={query} activeIndex={findOpen && matches ? currentIndex : null} onMatchCount={setPreviewMatches} />
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
                  query={query}
                  activeIndex={findOpen && matches ? currentIndex : null}
                  onMatchCount={setHexMatches}
                  className="replay-response mono"
                />
              : <HighlightedMessage className="replay-response mono" text={shown ?? ''} headers={messageHeaders(rawText)} showLineEndings={showLineEndings} wrap={wrap} query={query} activeIndex={findOpen && matches ? currentIndex : null} />}
    </div>
  </section>;
}

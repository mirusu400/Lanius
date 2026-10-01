import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { getFlow } from '../api/client';
import type { FlowDetail, FlowSummary, RequestVariant } from '../api/types';
import { formatUrl } from '../tabs/proxyModel';
import { sendToReplay } from '../tabs/replayStore';
import { sendToFuzzer } from '../tabs/fuzzerStore';
import { ContextMenu, useContextMenu, type MenuItem } from './ContextMenu';
import { Split } from './Split';
import { useCodegenMenu } from './useCodegenMenu';
import { usePluginActions } from './usePluginActions';
import { rawRequest, rawRequestVariant, rawResponse } from './rawHttp';
import {
  canReformat,
  formatBody,
  hexPreview,
  type BodyView,
} from './bodyFormat';
import { useT } from '../i18n';
import type { Translator } from '../i18n';
import { ResponsePreview } from './ResponsePreview';
import { HighlightedBody, HighlightedMessage } from './SyntaxCode';
import { matchCount } from './searchHighlight';
import { MarkedText } from './MarkedText';

interface Props {
  flow: FlowSummary | null;
  searchQuery?: string;
  onSentToReplay?: () => void;
  splitStorageKey?: string;
  initialSplit?: number;
}

/** How one half of the exchange is shown.
 *
 * The parsed view is easiest to read, the raw view is what actually went
 * over the wire, and hex is the only one that answers questions about
 * encoding or invisible bytes.
 */
type View = 'parsed' | 'raw' | 'hex' | 'preview';
type RequestStage = 'original' | 'auto_modified' | 'modified';

function HeaderList({
  headers,
  t,
  query,
  activeIndex,
}: {
  headers: [string, string][] | null;
  t: Translator;
  query: string;
  activeIndex: number | null;
}) {
  if (!headers || headers.length === 0)
    return <p className="muted">{t('common.none')}</p>;
  const headerOffsets = headers.map((_, index) => headers.slice(0, index).reduce(
    (sum, [name, value]) => sum + matchCount(name, query) + matchCount(value, query), 0,
  ));
  return (
    <table className="headers">
      <tbody>
        {headers.map(([name, value], i) => {
          const nameOffset = headerOffsets[i];
          const valueOffset = nameOffset + matchCount(name, query);
          return <tr key={`${name}-${i}`}>
            <td className="hname"><MarkedText text={name} query={query} offset={nameOffset} activeIndex={activeIndex} /></td>
            <td className="hvalue mono"><MarkedText text={value} query={query} offset={valueOffset} activeIndex={activeIndex} /></td>
          </tr>;
        })}
      </tbody>
    </table>
  );
}

/** One half of the exchange, with its own view switch. */
function Half({
  title,
  note,
  view,
  bodyView,
  onBodyView,
  onView,
  headers,
  body,
  raw,
  charsetLabel,
  encodingLabel,
  decodeError,
  requestStage,
  onRequestStage,
  onContextMenu,
  views,
  previewFlowId,
  fallbackMime,
  responsePath,
  http,
  t,
  onActivate,
  isActive,
  searchQuery,
}: {
  title: string;
  note?: string | null;
  view: View;
  bodyView: BodyView;
  onBodyView: (view: BodyView) => void;
  onView: (view: View) => void;
  headers: [string, string][] | null;
  body: string;
  raw: string;
  charsetLabel: string | null;
  encodingLabel: string | null;
  decodeError?: string | null;
  requestStage?: RequestStage;
  onRequestStage?: (stage: RequestStage) => void;
  onContextMenu: (event: React.MouseEvent) => void;
  /** Which views make sense here. A raw TCP stream has no headers, so
   * offering to parse it would only produce an empty table. */
  views: View[];
  previewFlowId?: string;
  fallbackMime?: string | null;
  responsePath?: string | null;
  http: boolean;
  t: Translator;
  onActivate: () => void;
  isActive: () => boolean;
  searchQuery: string;
}) {
  const hex = view === 'hex' ? hexPreview(raw) : null;
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [previewMatches, setPreviewMatches] = useState(0);
  const sectionRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const query = findOpen ? findQuery : searchQuery;
  const formattedBody = formatBody(body, bodyView) || t('common.empty');
  const headerMatches = view === 'parsed'
    ? (headers || []).reduce((count, [name, value]) => count + matchCount(name, query) + matchCount(value, query), 0)
    : 0;
  const matches = !query ? 0 : view === 'parsed' ? headerMatches + matchCount(formattedBody, query)
    : view === 'raw' ? matchCount(raw || t('common.empty'), query)
      : view === 'hex' ? matchCount(hex?.text || t('common.empty'), query)
        : previewMatches;
  const currentIndex = matches ? activeIndex % matches : 0;
  const selectedIndex = findOpen && query && matches ? currentIndex : null;

  const openFind = useCallback(() => {
    onActivate();
    if (!findOpen) {
      setFindQuery(searchQuery);
      setActiveIndex(0);
      setFindOpen(true);
    } else {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [onActivate, findOpen, searchQuery, setFindQuery, setActiveIndex, setFindOpen]);

  useEffect(() => {
    if (findOpen) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [findOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const inside = target instanceof Node && !!sectionRef.current?.contains(target);
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        if (event.defaultPrevented || !isActive()) return;
        if (!inside && target instanceof Element && target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')) return;
        event.preventDefault();
        openFind();
      } else if (event.key === 'Escape' && findOpen && inside) {
        event.preventDefault();
        setFindOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [isActive, findOpen, openFind]);

  useLayoutEffect(() => {
    if (!findOpen || !query || !matches) return;
    const mark = sectionRef.current?.querySelector<HTMLElement>(`.detail-half-body mark[data-find-index="${currentIndex}"]`);
    mark?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [findOpen, query, currentIndex, matches, view]);

  const move = (direction: number) => {
    if (matches) setActiveIndex((currentIndex + direction + matches) % matches);
  };

  return (
    <section className="detail-half" ref={sectionRef} onContextMenu={onContextMenu}
      onPointerDownCapture={onActivate}
      onFocusCapture={onActivate}>
      <div className="detail-half-bar">
        <span className="detail-half-title">{title}</span>
        {note && <span className="muted">{note}</span>}
        {charsetLabel && <span className="pill charset">{charsetLabel}</span>}
        {encodingLabel && <span className="pill encoding">{encodingLabel}</span>}
        {requestStage && onRequestStage && (
          <div className="request-variants" role="tablist">
            {(['original', 'auto_modified', 'modified'] as const).map((stage) => (
              <button
                key={stage}
                type="button"
                role="tab"
                aria-selected={requestStage === stage}
                className={requestStage === stage ? 'active' : ''}
                onClick={() => onRequestStage(stage)}
              >
                {t(
                  stage === 'original'
                    ? 'detail.originalRequest'
                    : stage === 'auto_modified'
                      ? 'detail.autoModifiedRequest'
                      : 'detail.modifiedRequest',
                )}
              </button>
            ))}
          </div>
        )}
        <div className="view-switch" role="tablist">
          {views.map((option) => (
            <button
              key={option}
              role="tab"
              aria-selected={view === option}
              className={view === option ? 'active' : ''}
              onClick={() => { if (option === 'preview') setPreviewMatches(0); onView(option); }}
            >
              {t(`detail.view.${option}`)}
            </button>
          ))}
        </div>
        <button type="button" className="detail-find-toggle" onClick={openFind} aria-label={t('detail.findIn', { pane: title })} title={t('detail.findShortcut')} aria-expanded={findOpen}>⌕</button>
      </div>
      {findOpen && <div className="detail-find-bar">
        <input ref={inputRef} type="search" aria-label={t('detail.findIn', { pane: title })} placeholder={t('detail.findPlaceholder')}
          value={findQuery} onChange={(event) => { setFindQuery(event.target.value); setActiveIndex(0); }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); move(event.shiftKey ? -1 : 1); }
          }} />
        <span className="detail-find-count" aria-live="polite">{query ? `${matches ? currentIndex + 1 : 0}/${matches}` : '0/0'}</span>
        <button type="button" onClick={() => move(-1)} disabled={!matches} aria-label={t('detail.findPrevious')}>↑</button>
        <button type="button" onClick={() => move(1)} disabled={!matches} aria-label={t('detail.findNext')}>↓</button>
        <button type="button" onClick={() => setFindOpen(false)} aria-label={t('detail.findClose')}>×</button>
      </div>}
      <div className="detail-half-body">
        {decodeError && <div className="banner error">{decodeError}</div>}
        {view === 'parsed' && (
          <>
            <h4>{t('detail.headers')}</h4>
            <HeaderList headers={headers} t={t} query={query} activeIndex={selectedIndex} />
            <h4>
              {t('detail.body')}
              {canReformat(body) && (
                // Only when laying it out would change something: a
                // control that does nothing is worse than none.
                <button
                  type="button"
                  className="link-button"
                  onClick={() => onBodyView(bodyView === 'pretty' ? 'raw' : 'pretty')}
                >
                  {bodyView === 'pretty' ? t('body.showRaw') : t('body.showPretty')}
                </button>
              )}
            </h4>
            <HighlightedBody
              text={formattedBody}
              headers={headers}
              fallbackMime={fallbackMime}
              responsePath={responsePath}
              query={query}
              activeIndex={selectedIndex}
              offset={headerMatches}
            />
          </>
        )}
        {view === 'raw' && (
          <HighlightedMessage
            className="raw-view mono"
            text={raw || t('common.empty')}
            headers={headers}
            fallbackMime={fallbackMime}
            responsePath={responsePath}
            http={http}
            query={query}
            activeIndex={selectedIndex}
          />
        )}
        {view === 'hex' && (
          <>
            <pre className="body mono"><MarkedText text={hex?.text || t('common.empty')} query={query} activeIndex={selectedIndex} /></pre>
            {hex && hex.truncated > 0 && (
              <p className="muted">
                {t('detail.hexTruncated', { count: String(hex.truncated) })}
              </p>
            )}
          </>
        )}
        {view === 'preview' && previewFlowId && <ResponsePreview flowId={previewFlowId} query={query} activeIndex={selectedIndex} onMatchCount={setPreviewMatches} />}
      </div>
    </section>
  );
}

export function FlowDetailView({ flow, searchQuery = '', onSentToReplay, splitStorageKey = 'lanius.split.detail', initialSplit = 0.5 }: Props) {
  const t = useT();
  const [detail, setDetail] = useState<FlowDetail | null>(null);
  const [reveal, setReveal] = useState(false);
  const [requestView, setRequestView] = useState<View>('parsed');
  const [responseView, setResponseView] = useState<View>('parsed');
  // Laid out by default: a captured JSON body is one long line, which is
  // not readable.
  const [requestBodyView, setRequestBodyView] = useState<BodyView>('pretty');
  const [responseBodyView, setResponseBodyView] = useState<BodyView>('pretty');
  const [requestStage, setRequestStage] = useState<RequestStage>('modified');
  const previousFlowId = useRef<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const menu = useContextMenu<'request' | 'response'>();
  const codegen = useCodegenMenu();
  const pluginActions = usePluginActions(setActionError);
  // Captured when the menu opens: the flow can change underneath while
  // it is open, and acting on a different request than the one that was
  // right-clicked is worse than the menu doing nothing.
  const target = useRef<{ flow: FlowSummary; detail: FlowDetail | null } | null>(
    null,
  );
  const activeHalf = useRef<'request' | 'response'>('response');
  const activateRequest = useCallback(() => { activeHalf.current = 'request'; }, []);
  const activateResponse = useCallback(() => { activeHalf.current = 'response'; }, []);
  const isRequestActive = useCallback(() => activeHalf.current === 'request', []);
  const isResponseActive = useCallback(() => activeHalf.current === 'response', []);

  useEffect(() => {
    if ((flow?.id ?? null) !== previousFlowId.current) {
      previousFlowId.current = flow?.id ?? null;
      setRequestStage('modified');
    }
    if (!flow) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    getFlow(flow.id, reveal)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [flow, flow?.status_code, reveal]);

  if (!flow) {
    return (
      <div className="flow-detail empty-detail">
        <p className="muted">{t('detail.selectPrompt')}</p>
      </div>
    );
  }

  const isTcp = flow.type === 'tcp';
  // A TCP stream is bytes, not a message with headers.
  const requestViews: View[] = isTcp ? ['raw', 'hex'] : ['parsed', 'raw', 'hex'];
  const responseViews: View[] = isTcp ? ['raw', 'hex'] : ['parsed', 'raw', 'hex', 'preview'];
  const pick = (view: View, views: View[]) => (views.includes(view) ? view : views[0]);

  const openMenu = (
    event: React.MouseEvent,
    message: 'request' | 'response',
  ) => {
    target.current = { flow, detail };
    menu.open(event, message);
  };

  const pluginMenu = pluginActions.buildMenu(
    menu.target ? ['flow', menu.target] : ['flow'],
    {
      flow_id: flow.id,
      flow,
      detail,
      message: menu.target,
    },
  );
  const menuItems: MenuItem[] = [
    {
      label: t('menu.sendToReplay'),
      onSelect: () => {
        const captured = target.current;
        if (!captured) return;
        sendToReplay(captured.flow, captured.detail);
        onSentToReplay?.();
      },
    },
    {
      label: t('menu.sendToFuzzer'),
      onSelect: () => {
        const captured = target.current;
        if (captured) sendToFuzzer(captured.flow, captured.detail);
      },
    },
    codegen.buildMenu({ flow_id: flow.id }),
    ...(pluginMenu ? [pluginMenu] : []),
  ];

  const charsetOf = (charset: string | null | undefined) =>
    // Only when it is not the default, so the common case stays quiet.
    charset && charset !== 'utf-8'
      ? t('detail.charset', { charset })
      : null;

  const variants = detail?.request_variants ?? null;
  const selectedVariant: RequestVariant | null = variants
    ? variants[requestStage]
    : null;
  const requestEncoding = selectedVariant
    ? selectedVariant.content_encoding
    : detail?.request_content_encoding;
  const requestDecoded = selectedVariant
    ? selectedVariant.body_decoded
    : detail?.request_body_decoded;
  const requestDecodeError = selectedVariant
    ? selectedVariant.decode_error
    : detail?.request_decode_error;
  const encodingOf = (
    encoding: string | null | undefined,
    decoded: boolean | undefined,
  ) =>
    encoding && decoded
      ? t('detail.decompressed', { encoding })
      : null;
  const decodeErrorOf = (
    encoding: string | null | undefined,
    error: string | null | undefined,
  ) =>
    encoding && error
      ? `${t('detail.decodeError', { encoding })}: ${error}`
      : null;

  const request = (
    <Half
      title={isTcp ? t('detail.toServer') : t('detail.request')}
      // "3 messages": a TCP stream is several exchanges concatenated,
      // and without the count the pane looks like one message.
      note={isTcp ? flow.comment : null}
      view={pick(requestView, requestViews)}
      onView={setRequestView}
      views={requestViews}
      bodyView={requestBodyView}
      onBodyView={setRequestBodyView}
      body={selectedVariant?.body ?? detail?.request_body ?? ''}
      raw={
        isTcp
          ? (detail?.request_body ?? '')
          : selectedVariant
            ? rawRequestVariant(selectedVariant)
            : rawRequest(flow, detail)
      }
      headers={selectedVariant?.headers ?? detail?.request_headers ?? null}
      charsetLabel={charsetOf(selectedVariant?.charset ?? detail?.request_charset)}
      encodingLabel={encodingOf(requestEncoding, requestDecoded)}
      decodeError={decodeErrorOf(requestEncoding, requestDecodeError)}
      requestStage={variants ? requestStage : undefined}
      onRequestStage={variants ? setRequestStage : undefined}
      onContextMenu={(event) => openMenu(event, 'request')}
      http={!isTcp}
      t={t}
      onActivate={activateRequest}
      isActive={isRequestActive}
      searchQuery={searchQuery}
    />
  );

  const response = (
    <Half
      title={
        isTcp
          ? t('detail.toClient')
          : `${t('detail.response')} ${
              flow.status_code ? `(${flow.status_code})` : ''
            }`.trim()
      }
      view={pick(responseView, responseViews)}
      onView={setResponseView}
      views={responseViews}
      previewFlowId={flow.id}
      bodyView={responseBodyView}
      onBodyView={setResponseBodyView}
      headers={detail?.response_headers ?? null}
      body={detail?.response_body ?? ''}
      raw={isTcp ? (detail?.response_body ?? '') : rawResponse(flow, detail)}
      charsetLabel={charsetOf(detail?.response_charset)}
      encodingLabel={encodingOf(
        detail?.response_content_encoding,
        detail?.response_body_decoded,
      )}
      decodeError={decodeErrorOf(
        detail?.response_content_encoding,
        detail?.response_decode_error,
      )}
      onContextMenu={(event) => openMenu(event, 'response')}
      fallbackMime={flow.response_mime}
      responsePath={flow.path}
      http={!isTcp}
      t={t}
      onActivate={activateResponse}
      isActive={isResponseActive}
      searchQuery={searchQuery}
    />
  );

  return (
    <div className="flow-detail">
      <div className="detail-url mono">
        {/* The URL is the part that can be long, so it is the part that
            shrinks. Without this the reveal toggle is pushed off the
            edge of the pane and cannot be reached at all. */}
        <span className="detail-url-text" title={formatUrl(flow)}>
          <strong><MarkedText text={flow.method || ''} query={searchQuery} /></strong> <MarkedText text={formatUrl(flow)} query={searchQuery} />
        </span>
        <label className="reveal">
          <input
            type="checkbox"
            checked={reveal}
            onChange={(e) => setReveal(e.target.checked)}
          />
          {t('detail.revealSecrets')}
        </label>
      </div>
      {actionError && <div className="banner error">{actionError}</div>}
      {/* Stacked rather than tabbed: comparing what was sent with what
          came back is the usual reason to open a flow at all. */}
      <Split
        direction="vertical"
        storageKey={splitStorageKey}
        initial={initialSplit}
        first={request}
        second={response}
      />
      <ContextMenu
        position={menu.position}
        items={menuItems}
        onClose={menu.close}
      />
    </div>
  );
}

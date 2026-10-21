import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { getFlow, getFlowBodyPreview, getReplayRequest } from '../api/client';
import type { FlowDetail, FlowSummary, RequestVariant } from '../api/types';
import { formatUrl, formatBytes } from '../tabs/proxyModel';
import { sendToReplay } from '../tabs/replayStore';
import { sendToFuzzer } from '../tabs/fuzzerStore';
import { ContextMenu, useContextMenu } from './ContextMenu';
import { UpstreamError } from './UpstreamError';
import { requestMenuItems } from './requestMenu';
import { useAddRequestScopeRule } from './requestScope';
import { Split } from './Split';
import { InspectorPanel } from './InspectorPanel';
import { useInspectorOpen, useInspectorSelection } from './useInspector';
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
import { useShortcuts } from '../useShortcut';
import { UndoableInput } from './UndoableText';
import { copyTextToClipboard } from '../clipboard';
import { CodeDisplayControls } from './CodeDisplayControls';
import { LoadingPane } from './Spinner';
import { selectedText } from './textDocument';

interface Props {
  flow: FlowSummary | null;
  searchQuery?: string;
  onSentToReplay?: () => void;
  splitStorageKey?: string;
  initialSplit?: number;
  /** Offer the Inspector beside the exchange. */
  inspector?: boolean;
}

/** How one half of the exchange is shown.
 *
 * The parsed view is easiest to read, the raw view is what actually went
 * over the wire, and hex is the only one that answers questions about
 * encoding or invisible bytes.
 */
type View = 'parsed' | 'raw' | 'hex' | 'preview';
type RequestStage = 'original' | 'auto_modified' | 'modified';

const CHARSET_OPTIONS = [
  ['utf-8', 'UTF-8'],
  ['cp949', 'CP949 / Windows-949'],
  ['euc-kr', 'EUC-KR'],
  ['shift_jis', 'Shift_JIS'],
  ['gb18030', 'GB18030'],
  ['big5', 'Big5'],
  ['windows-1252', 'Windows-1252'],
  ['iso-8859-1', 'ISO-8859-1'],
  ['utf-16-le', 'UTF-16 LE'],
  ['utf-16-be', 'UTF-16 BE'],
] as const;

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
  bodyOmitted,
  bodySize,
  bodyCapturedSize,
  bodyPreviewSize,
  bodyTruncated,
  bodyChunkable,
  loadingMore,
  loading = false,
  onLoadMore,
  raw,
  charset,
  charsetOverride,
  onCharsetOverride,
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
  bodyOmitted?: boolean;
  bodySize?: number;
  bodyCapturedSize?: number;
  bodyPreviewSize?: number;
  bodyTruncated?: boolean;
  bodyChunkable?: boolean;
  loadingMore?: boolean;
  loading?: boolean;
  onLoadMore?: () => void;
  raw: string;
  charset: string | null | undefined;
  charsetOverride: string;
  onCharsetOverride: (charset: string) => void;
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
  const hex = useMemo(() => view === 'hex' ? hexPreview(raw) : null, [raw, view]);
  const [findOpen, setFindOpen] = useState(false);
  const [showLineEndings, setShowLineEndings] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [findQuery, setFindQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [previewMatches, setPreviewMatches] = useState(0);
  const sectionRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const query = findOpen ? findQuery : searchQuery;
  const formatted = useMemo(() => view === 'parsed' ? formatBody(body, bodyView) : '', [body, bodyView, view]);
  const formattedBody = formatted || t('common.empty');
  const reformattable = useMemo(() => view === 'parsed' && canReformat(body), [body, view]);
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
        {http && <label className="detail-charset">
          <span>{t('detail.charsetOption')}</span>
          <select
            aria-label={t('detail.charsetFor', { pane: title })}
            title={t('detail.charsetFor', { pane: title })}
            value={charsetOverride}
            onChange={(event) => onCharsetOverride(event.target.value)}
          >
            <option value="">{t('detail.charsetAuto', { charset: charset || 'utf-8' })}</option>
            {CHARSET_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>}
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
        <CodeDisplayControls showLineEndings={showLineEndings} onShowLineEndings={setShowLineEndings}
          wrap={wrap} onWrap={setWrap} disabled={view === 'preview' || view === 'hex'} />
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
        <UndoableInput inputRef={inputRef} type="search" aria-label={t('detail.findIn', { pane: title })} placeholder={t('detail.findPlaceholder')}
          value={findQuery} onValueChange={(value) => { setFindQuery(value); setActiveIndex(0); }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); move(event.shiftKey ? -1 : 1); }
          }} />
        <span className="detail-find-count" aria-live="polite">{query ? `${matches ? currentIndex + 1 : 0}/${matches}` : '0/0'}</span>
        <button type="button" onClick={() => move(-1)} disabled={!matches} aria-label={t('detail.findPrevious')}>↑</button>
        <button type="button" onClick={() => move(1)} disabled={!matches} aria-label={t('detail.findNext')}>↓</button>
        <button type="button" onClick={() => setFindOpen(false)} aria-label={t('detail.findClose')}>×</button>
      </div>}
      <div className="detail-half-body" aria-busy={loading}>
        {loading ? <LoadingPane label={t('detail.preview.loading')} /> : <>
        {bodyOmitted && <p className="banner" role="status">{t('detail.mediaBodyOmitted', { size: formatBytes(bodySize ?? 0) })}</p>}
        {bodyTruncated && view !== 'preview' && <div className="banner body-preview-notice" role="status">
          <span>{encodingLabel
            // Decoded bytes against a compressed total would read as
            // "256 KB of 40 KB"; the decoded length is unknown here.
            ? t('detail.bodyTruncatedDecoded', { shown: formatBytes(bodyPreviewSize ?? 0) })
            : t('detail.bodyTruncated', {
                shown: formatBytes(bodyPreviewSize ?? 0),
                total: formatBytes(bodyCapturedSize ?? bodySize ?? 0),
              })}</span>
          {bodyChunkable && onLoadMore
            ? <button type="button" onClick={onLoadMore} disabled={loadingMore}>
                {loadingMore ? t('detail.loadingMore') : t('detail.loadMore')}
              </button>
            : <span className="muted">{t('detail.bodyChunkUnavailable')}</span>}
        </div>}
        {decodeError && <div className="banner error">{decodeError}</div>}
        {view === 'parsed' && (
          <>
            <h4>{t('detail.headers')}</h4>
            <HeaderList headers={headers} t={t} query={query} activeIndex={selectedIndex} />
            <h4>
              {t('detail.body')}
              {reformattable && (
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
            {!bodyOmitted && <HighlightedBody
              text={formattedBody}
              headers={headers}
              fallbackMime={fallbackMime}
              responsePath={responsePath}
              query={query}
              activeIndex={selectedIndex}
              offset={headerMatches}
              showLineEndings={showLineEndings}
              wrap={wrap}
            />}
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
            showLineEndings={showLineEndings}
            wrap={wrap}
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
        {view === 'preview' && previewFlowId && !bodyOmitted && <ResponsePreview flowId={previewFlowId} charset={charsetOverride || null} query={query} activeIndex={selectedIndex} onMatchCount={setPreviewMatches} />}
        </>}
      </div>
    </section>
  );
}

export function FlowDetailView({ flow, searchQuery = '', onSentToReplay, splitStorageKey = 'lanius.split.detail', initialSplit = 0.5, inspector = false }: Props) {
  const t = useT();
  const addRequestScopeRule = useAddRequestScopeRule();
  const [detail, setDetail] = useState<FlowDetail | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [reveal, setReveal] = useState(true);
  const layoutStorageKey = `${splitStorageKey}.layout`;
  const [exchangeDirection, setExchangeDirection] = useState<'horizontal' | 'vertical'>(() =>
    window.localStorage.getItem(layoutStorageKey) === 'horizontal' ? 'horizontal' : 'vertical');
  const [requestView, setRequestView] = useState<View>('parsed');
  const [responseView, setResponseView] = useState<View>('parsed');
  // Laid out by default: a captured JSON body is one long line, which is
  // not readable.
  const [requestBodyView, setRequestBodyView] = useState<BodyView>('pretty');
  const [responseBodyView, setResponseBodyView] = useState<BodyView>('pretty');
  const [requestStage, setRequestStage] = useState<RequestStage>('modified');
  const [charsetChoices, setCharsetChoices] = useState({
    flowId: null as string | null,
    request: '',
    response: '',
  });
  const previousFlowId = useRef<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState<'request' | 'response' | null>(null);
  const menu = useContextMenu<{
    message: 'request' | 'response';
    flow: FlowSummary;
    detail: FlowDetail | null;
    selection: string;
  }>();
  const codegen = useCodegenMenu();
  const pluginActions = usePluginActions(setActionError);
  const activeHalf = useRef<'request' | 'response'>('response');
  const activateRequest = useCallback(() => { activeHalf.current = 'request'; }, []);
  const activateResponse = useCallback(() => { activeHalf.current = 'response'; }, []);
  const isRequestActive = useCallback(() => activeHalf.current === 'request', []);
  const isResponseActive = useCallback(() => activeHalf.current === 'response', []);
  const currentFlowId = flow?.id ?? null;
  const [inspectorOpen, toggleInspector] = useInspectorOpen();
  const exchangeRef = useRef<HTMLDivElement | null>(null);
  const [selection] = useInspectorSelection(exchangeRef, currentFlowId);
  const requestCharsetOverride = charsetChoices.flowId === currentFlowId
    ? charsetChoices.request
    : '';
  const responseCharsetOverride = charsetChoices.flowId === currentFlowId
    ? charsetChoices.response
    : '';
  const detailKey = JSON.stringify([currentFlowId, flow?.status_code, flow?.completed_at, flow?.request_size, flow?.response_size, flow?.modified, flow?.error, reveal, requestCharsetOverride, responseCharsetOverride]);
  const detailLoading = Boolean(flow && loadedKey !== detailKey);

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
    const controller = new AbortController();
    getFlow(flow.id, reveal, {
      request: requestCharsetOverride,
      response: responseCharsetOverride,
    }, controller.signal)
      .then((d) => {
        if (!cancelled) { setDetail(d); setLoadedKey(detailKey); }
      })
      .catch((error: unknown) => {
        if (!cancelled) { setDetail(null); setLoadedKey(detailKey); setActionError(error instanceof Error ? error.message : String(error)); }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [flow, detailKey, reveal, requestCharsetOverride, responseCharsetOverride]);

  const sendRequest = (
    selected: FlowSummary | null,
    send: (flow: FlowSummary, detail: FlowDetail) => void,
  ) => {
    if (!selected) return;
    // The displayed detail may have masked headers or a truncated body.
    // Editors always need the complete, unmasked request, independently of
    // the reveal toggle. Fetch only the request to avoid the response BLOB.
    void getReplayRequest(
      selected.id,
      true,
      selected.id === currentFlowId ? requestCharsetOverride : null,
    )
      .then((fetched) => send(selected, fetched))
      .catch((err: Error) => setActionError(err.message));
  };

  const loadMoreBody = (side: 'request' | 'response') => {
    if (!flow || !detail || loadingMore) return;
    const offset = detail[`${side}_body_preview_size`] ?? 0;
    const selectedCharset = side === 'request'
      ? requestCharsetOverride
      : responseCharsetOverride;
    setLoadingMore(side);
    setActionError(null);
    void getFlowBodyPreview(flow.id, side, offset, selectedCharset || null)
      .then((chunk) => {
        setDetail((current) => {
          if (!current || current.id !== flow.id) return current;
          const key = `${side}_body` as const;
          return {
            ...current,
            [key]: `${current[key] ?? ''}${chunk.text}`,
            [`${side}_charset`]: chunk.charset,
            [`${side}_body_preview_size`]: chunk.next_offset,
            [`${side}_body_captured_size`]: chunk.total_bytes,
            [`${side}_body_truncated`]: chunk.truncated,
          };
        });
      })
      .catch((err: Error) => setActionError(err.message))
      .finally(() => setLoadingMore(null));
  };
  const openInReplay = (selected: FlowSummary, loaded: FlowDetail) => {
    sendToReplay(selected, loaded);
    onSentToReplay?.();
  };
  useShortcuts({
    'request.sendToReplay': () => sendRequest(flow, openInReplay),
    'request.sendToFuzzer': () => sendRequest(flow, sendToFuzzer),
  }, Boolean(flow));

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
  const setCharsetOverride = (
    side: 'request' | 'response',
    value: string,
  ) => {
    setCharsetChoices((current) => ({
      flowId: flow.id,
      request: current.flowId === flow.id ? current.request : '',
      response: current.flowId === flow.id ? current.response : '',
      [side]: value,
    }));
  };

  const openMenu = (
    event: React.MouseEvent,
    message: 'request' | 'response',
  ) => {
    // Capture this before opening the menu: clicking an action can collapse
    // the browser selection. Ignore a stale selection from the other pane.
    menu.open(event, { message, flow, detail, selection: selectedText(event.currentTarget, event.target) });
  };

  const menuFlow = menu.target?.flow ?? flow;
  const menuDetail = menu.target ? menu.target.detail : detail;
  const pluginMenu = pluginActions.buildMenu(
    menu.target ? ['flow', menu.target.message] : ['flow'],
    {
      flow_id: menuFlow.id,
      flow: menuFlow,
      detail: menuDetail,
      message: menu.target?.message,
    },
  );
  const menuItems = requestMenuItems(t, {
    url: menuFlow.type === 'http' ? formatUrl(menuFlow) : null,
    addScopeRule: menuFlow.type === 'http'
      ? (kind, target) => void addRequestScopeRule(formatUrl(menuFlow), kind, target)
      : undefined,
    sendToReplay: () => {
      const captured = menu.target;
      if (!captured) return;
      sendRequest(captured.flow, openInReplay);
    },
    sendToFuzzer: () => {
      const captured = menu.target;
      if (captured) sendRequest(captured.flow, sendToFuzzer);
    },
    copyAs: codegen.buildMenu({ flow_id: menuFlow.id }),
    pluginActions: pluginMenu,
    before: [{
      label: t('editor.copy'),
      disabled: !menu.target?.selection,
      onSelect: () => copyTextToClipboard(menu.target?.selection ?? ''),
    }],
  });

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
      bodyOmitted={selectedVariant?.body_omitted ?? detail?.request_body_omitted}
      bodySize={selectedVariant?.body_size ?? detail?.request_size}
      bodyCapturedSize={detail?.request_body_captured_size}
      bodyPreviewSize={detail?.request_body_preview_size}
      bodyTruncated={!selectedVariant && detail?.request_body_truncated}
      bodyChunkable={detail?.request_body_chunkable}
      loadingMore={loadingMore === 'request'}
      loading={detailLoading}
      onLoadMore={() => loadMoreBody('request')}
      raw={
        isTcp
          ? (detail?.request_body ?? '')
          : selectedVariant
            ? rawRequestVariant(selectedVariant)
            : rawRequest(flow, detail)
      }
      headers={selectedVariant?.headers ?? detail?.request_headers ?? null}
      charset={selectedVariant?.charset ?? detail?.request_charset}
      charsetOverride={requestCharsetOverride}
      onCharsetOverride={(value) => setCharsetOverride('request', value)}
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
      bodyOmitted={detail?.response_body_omitted}
      bodySize={detail?.response_size}
      bodyCapturedSize={detail?.response_body_captured_size}
      bodyPreviewSize={detail?.response_body_preview_size}
      bodyTruncated={detail?.response_body_truncated}
      bodyChunkable={detail?.response_body_chunkable}
      loadingMore={loadingMore === 'response'}
      loading={detailLoading}
      onLoadMore={() => loadMoreBody('response')}
      raw={isTcp ? (detail?.response_body ?? '') : rawResponse(flow, detail)}
      charset={detail?.response_charset}
      charsetOverride={responseCharsetOverride}
      onCharsetOverride={(value) => setCharsetOverride('response', value)}
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
        <button type="button" className="code-display-toggle" aria-label={t('detail.exchangeSideBySide')}
          aria-pressed={exchangeDirection === 'horizontal'}
          title={t(exchangeDirection === 'horizontal' ? 'detail.exchangeStacked' : 'detail.exchangeSideBySide')}
          onClick={() => {
            const next = exchangeDirection === 'horizontal' ? 'vertical' : 'horizontal';
            setExchangeDirection(next);
            window.localStorage.setItem(layoutStorageKey, next);
          }}>
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <rect x="3" y="3" width="14" height="14" rx="2" />
            {exchangeDirection === 'horizontal' ? <path d="M3 10h14" /> : <path d="M10 3v14" />}
          </svg>
        </button>
        <label className="reveal">
          <input
            type="checkbox"
            checked={reveal}
            onChange={(e) => setReveal(e.target.checked)}
          />
          {t('detail.revealSecrets')}
        </label>
        {inspector && (
          <button
            type="button"
            className={inspectorOpen ? 'inspector-toggle active' : 'inspector-toggle'}
            aria-pressed={inspectorOpen}
            aria-label={t('inspector.toggleLabel')}
            title={t('inspector.toggleLabel')}
            onClick={toggleInspector}
          >
            {t('inspector.toggle')}
          </button>
        )}
      </div>
      {actionError && <div className="banner error">{actionError}</div>}
      <UpstreamError
        key={flow.id}
        error={flow.error}
        host={flow.host}
        hasResponse={flow.status_code != null}
      />
      {/* Keep both messages mounted when changing the exchange layout. */}
      <Split
        direction="horizontal"
        storageKey={`${splitStorageKey}.inspector`}
        initial={0.72}
        secondHidden={!inspector || !inspectorOpen}
        first={
          <div className="inspector-host" ref={exchangeRef}>
            <Split
              direction={exchangeDirection}
              storageKey={exchangeDirection === 'vertical' ? splitStorageKey : `${splitStorageKey}.horizontal`}
              initial={initialSplit}
              first={request}
              second={response}
            />
          </div>
        }
        second={
          <InspectorPanel
            selection={selection}
            request={isTcp ? '' : rawRequest(flow, detail)}
            onEditInReplay={isTcp ? undefined : () => sendRequest(flow, openInReplay)}
          />
        }
      />
      <ContextMenu
        position={menu.position}
        items={menuItems}
        onClose={menu.close}
      />
    </div>
  );
}

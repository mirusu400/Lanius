import { useEffect, useRef, useState } from 'react';

import { getFlow } from '../api/client';
import type { FlowDetail, FlowSummary } from '../api/types';
import { formatUrl } from '../tabs/proxyModel';
import { sendToRepeater } from '../tabs/repeaterStore';
import { sendToIntruder } from '../tabs/intruderStore';
import { ContextMenu, useContextMenu, type MenuItem } from './ContextMenu';
import { Split } from './Split';
import { useCodegenMenu } from './useCodegenMenu';
import { rawRequest, rawResponse } from './rawHttp';
import { canReformat, formatBody, type BodyView } from './bodyFormat';
import { useT } from '../i18n';
import type { Translator } from '../i18n';

interface Props {
  flow: FlowSummary | null;
  onSentToRepeater?: () => void;
}

/** How one half of the exchange is shown.
 *
 * The parsed view is easiest to read, the raw view is what actually went
 * over the wire, and hex is the only one that answers questions about
 * encoding or invisible bytes.
 */
type View = 'parsed' | 'raw' | 'hex';

// Hex costs four characters per byte, so a body that is merely large as
// text becomes unmanageable as a dump. The cap is applied to the bytes
// before formatting, with a note, rather than freezing the window.
const HEX_LIMIT = 64 * 1024;

function HeaderList({
  headers,
  t,
}: {
  headers: [string, string][] | null;
  t: Translator;
}) {
  if (!headers || headers.length === 0)
    return <p className="muted">{t('common.none')}</p>;
  return (
    <table className="headers">
      <tbody>
        {headers.map(([name, value], i) => (
          <tr key={`${name}-${i}`}>
            <td className="hname">{name}</td>
            <td className="hvalue mono">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Classic hex dump: offset, bytes, printable ASCII. */
export function toHex(text: string, width = 16): string {
  const bytes = new TextEncoder().encode(text);
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += width) {
    const chunk = bytes.slice(offset, offset + width);
    const hex = [...chunk]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ')
      .padEnd(width * 3 - 1, ' ');
    const ascii = [...chunk]
      .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.'))
      .join('');
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex}  |${ascii}|`);
  }
  return lines.join('\n');
}

/** A hex dump of at most HEX_LIMIT bytes, and whether it was cut. */
export function hexPreview(text: string): { text: string; truncated: number } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= HEX_LIMIT) return { text: toHex(text), truncated: 0 };
  // Decoded back so toHex works on one representation; the slice is on a
  // byte boundary, so a multi-byte character at the edge shows as the
  // replacement character rather than shifting every following offset.
  const head = new TextDecoder().decode(bytes.slice(0, HEX_LIMIT));
  return { text: toHex(head), truncated: bytes.length - HEX_LIMIT };
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
  onContextMenu,
  views,
  t,
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
  onContextMenu: (event: React.MouseEvent) => void;
  /** Which views make sense here. A raw TCP stream has no headers, so
   * offering to parse it would only produce an empty table. */
  views: View[];
  t: Translator;
}) {
  const hex = view === 'hex' ? hexPreview(raw) : null;

  return (
    <section className="detail-half" onContextMenu={onContextMenu}>
      <div className="detail-half-bar">
        <span className="detail-half-title">{title}</span>
        {note && <span className="muted">{note}</span>}
        {charsetLabel && <span className="pill charset">{charsetLabel}</span>}
        <div className="view-switch" role="tablist">
          {views.map((option) => (
            <button
              key={option}
              role="tab"
              aria-selected={view === option}
              className={view === option ? 'active' : ''}
              onClick={() => onView(option)}
            >
              {t(`detail.view.${option}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="detail-half-body">
        {view === 'parsed' && (
          <>
            <h4>{t('detail.headers')}</h4>
            <HeaderList headers={headers} t={t} />
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
            <pre className="body mono">
              {formatBody(body, bodyView) || t('common.empty')}
            </pre>
          </>
        )}
        {view === 'raw' && (
          // Editable-looking but read only: this is a record of what was
          // sent, and changing it here would change nothing.
          <textarea
            className="raw-view mono"
            readOnly
            spellCheck={false}
            value={raw || t('common.empty')}
          />
        )}
        {view === 'hex' && (
          <>
            <pre className="body mono">{hex?.text || t('common.empty')}</pre>
            {hex && hex.truncated > 0 && (
              <p className="muted">
                {t('detail.hexTruncated', { count: String(hex.truncated) })}
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

export function FlowDetailView({ flow, onSentToRepeater }: Props) {
  const t = useT();
  const [detail, setDetail] = useState<FlowDetail | null>(null);
  const [reveal, setReveal] = useState(false);
  const [requestView, setRequestView] = useState<View>('parsed');
  const [responseView, setResponseView] = useState<View>('parsed');
  // Laid out by default: a captured JSON body is one long line, which is
  // not readable.
  const [requestBodyView, setRequestBodyView] = useState<BodyView>('pretty');
  const [responseBodyView, setResponseBodyView] = useState<BodyView>('pretty');
  const menu = useContextMenu<null>();
  const codegen = useCodegenMenu();
  // Captured when the menu opens: the flow can change underneath while
  // it is open, and acting on a different request than the one that was
  // right-clicked is worse than the menu doing nothing.
  const target = useRef<{ flow: FlowSummary; detail: FlowDetail | null } | null>(
    null,
  );

  useEffect(() => {
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
  const views: View[] = isTcp ? ['raw', 'hex'] : ['parsed', 'raw', 'hex'];
  const pick = (view: View) => (views.includes(view) ? view : views[0]);

  const openMenu = (event: React.MouseEvent) => {
    target.current = { flow, detail };
    menu.open(event, null);
  };

  const menuItems: MenuItem[] = [
    {
      label: t('menu.sendToRepeater'),
      onSelect: () => {
        const captured = target.current;
        if (!captured) return;
        sendToRepeater(captured.flow, captured.detail);
        onSentToRepeater?.();
      },
    },
    {
      label: t('menu.sendToIntruder'),
      onSelect: () => {
        const captured = target.current;
        if (captured) sendToIntruder(captured.flow, captured.detail);
      },
    },
    codegen.buildMenu({ flow_id: flow.id }),
  ];

  const charsetOf = (charset: string | null | undefined) =>
    // Only when it is not the default, so the common case stays quiet.
    charset && charset !== 'utf-8'
      ? t('detail.charset', { charset })
      : null;

  const request = (
    <Half
      title={isTcp ? t('detail.toServer') : t('detail.request')}
      // "3 messages": a TCP stream is several exchanges concatenated,
      // and without the count the pane looks like one message.
      note={isTcp ? flow.comment : null}
      view={pick(requestView)}
      onView={setRequestView}
      views={views}
      bodyView={requestBodyView}
      onBodyView={setRequestBodyView}
      headers={detail?.request_headers ?? null}
      body={detail?.request_body ?? ''}
      raw={isTcp ? (detail?.request_body ?? '') : rawRequest(flow, detail)}
      charsetLabel={charsetOf(detail?.request_charset)}
      onContextMenu={openMenu}
      t={t}
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
      view={pick(responseView)}
      onView={setResponseView}
      views={views}
      bodyView={responseBodyView}
      onBodyView={setResponseBodyView}
      headers={detail?.response_headers ?? null}
      body={detail?.response_body ?? ''}
      raw={isTcp ? (detail?.response_body ?? '') : rawResponse(flow, detail)}
      charsetLabel={charsetOf(detail?.response_charset)}
      onContextMenu={openMenu}
      t={t}
    />
  );

  return (
    <div className="flow-detail">
      <div className="detail-url mono">
        {/* The URL is the part that can be long, so it is the part that
            shrinks. Without this the reveal toggle is pushed off the
            edge of the pane and cannot be reached at all. */}
        <span className="detail-url-text" title={formatUrl(flow)}>
          <strong>{flow.method}</strong> {formatUrl(flow)}
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
      {/* Stacked rather than tabbed: comparing what was sent with what
          came back is the usual reason to open a flow at all. */}
      <Split
        direction="vertical"
        storageKey="lanius.split.detail"
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

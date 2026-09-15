import { useEffect, useState } from 'react';

import { getFlow } from '../api/client';
import type { FlowDetail, FlowSummary } from '../api/types';
import { formatUrl } from '../tabs/proxyModel';
import { sendToRepeater } from '../tabs/repeaterStore';
import { sendToIntruder } from '../tabs/intruderStore';
import { useT } from '../i18n';
import type { Translator } from '../i18n';

interface Props {
  flow: FlowSummary | null;
  onSentToRepeater?: () => void;
}

type Pane = 'request' | 'response';

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

export function FlowDetailView({ flow, onSentToRepeater }: Props) {
  const t = useT();
  const [detail, setDetail] = useState<FlowDetail | null>(null);
  const [pane, setPane] = useState<Pane>('request');
  const [reveal, setReveal] = useState(false);

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
  const body = pane === 'request' ? detail?.request_body : detail?.response_body;
  const headers =
    pane === 'request'
      ? (detail?.request_headers ?? null)
      : (detail?.response_headers ?? null);

  const shownCharset =
    pane === 'response' ? detail?.response_charset : detail?.request_charset;
  // Only when it is not the default, so the common case stays quiet.
  const charsetLabel =
    shownCharset && shownCharset !== 'utf-8'
      ? t('detail.charset', { charset: shownCharset })
      : null;

  return (
    <div className="flow-detail">
      <div className="detail-url mono" title={formatUrl(flow)}>
        <strong>{flow.method}</strong> {formatUrl(flow)}
        {charsetLabel && (
          // Worth saying: a page that is not UTF-8 is only readable
          // because it was decoded with the charset it declared.
          <span className="pill charset">{charsetLabel}</span>
        )}
      </div>
      <div className="detail-tabs">
        <button
          className={pane === 'request' ? 'active' : ''}
          onClick={() => setPane('request')}
        >
          {isTcp ? t('detail.toServer') : t('detail.request')}
        </button>
        <button
          className={pane === 'response' ? 'active' : ''}
          onClick={() => setPane('response')}
        >
          {isTcp
            ? t('detail.toClient')
            : `${t('detail.response')} ${
                flow.status_code ? `(${flow.status_code})` : ''
              }`.trim()}
        </button>
        <button
          className="to-repeater"
          onClick={() => {
            sendToRepeater(flow, detail);
            onSentToRepeater?.();
          }}
        >
          {t('detail.sendToRepeater')}
        </button>
        <button
          className="to-repeater"
          onClick={() => sendToIntruder(flow, detail)}
        >
          {t('detail.sendToIntruder')}
        </button>
        <label className="reveal">
          <input
            type="checkbox"
            checked={reveal}
            onChange={(e) => setReveal(e.target.checked)}
          />
          {t('detail.revealSecrets')}
        </label>
      </div>
      <div className="detail-body">
        {isTcp ? (
          <>
            <h4>
              {t('detail.rawBytes')}
              {flow.comment ? ` · ${flow.comment}` : ''}
            </h4>
            <pre className="body mono">{body || t('common.empty')}</pre>
            <h4>{t('detail.hex')}</h4>
            <pre className="body mono">
              {toHex(body ?? '') || t('common.empty')}
            </pre>
          </>
        ) : (
          <>
            <h4>{t('detail.headers')}</h4>
            <HeaderList headers={headers} t={t} />
            <h4>{t('detail.body')}</h4>
            <pre className="body mono">{body || t('common.empty')}</pre>
          </>
        )}
      </div>
    </div>
  );
}

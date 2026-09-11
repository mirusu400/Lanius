import { useEffect, useState } from 'react';

import { getFlow } from '../api/client';
import type { FlowDetail, FlowSummary } from '../api/types';
import { formatUrl } from '../tabs/proxyModel';
import { sendToRepeater } from '../tabs/repeaterStore';
import { sendToIntruder } from '../tabs/intruderStore';

interface Props {
  flow: FlowSummary | null;
  onSentToRepeater?: () => void;
}

type Pane = 'request' | 'response';

function HeaderList({ headers }: { headers: [string, string][] | null }) {
  if (!headers || headers.length === 0) return <p className="muted">없음</p>;
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
  return lines.join('\n') || '(비어 있음)';
}

export function FlowDetailView({ flow, onSentToRepeater }: Props) {
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
        <p className="muted">flow를 선택하면 상세 내용이 표시됩니다.</p>
      </div>
    );
  }

  const isTcp = flow.type === 'tcp';
  const body = pane === 'request' ? detail?.request_body : detail?.response_body;
  const headers =
    pane === 'request'
      ? (detail?.request_headers ?? null)
      : (detail?.response_headers ?? null);

  return (
    <div className="flow-detail">
      <div className="detail-url mono" title={formatUrl(flow)}>
        <strong>{flow.method}</strong> {formatUrl(flow)}
      </div>
      <div className="detail-tabs">
        <button
          className={pane === 'request' ? 'active' : ''}
          onClick={() => setPane('request')}
        >
          {isTcp ? '→ Server' : 'Request'}
        </button>
        <button
          className={pane === 'response' ? 'active' : ''}
          onClick={() => setPane('response')}
        >
          {isTcp
            ? '← Client'
            : `Response ${flow.status_code ? `(${flow.status_code})` : ''}`}
        </button>
        <button
          className="to-repeater"
          onClick={() => {
            sendToRepeater(flow, detail);
            onSentToRepeater?.();
          }}
        >
          Send to Repeater
        </button>
        <button
          className="to-repeater"
          onClick={() => sendToIntruder(flow, detail)}
        >
          Send to Intruder
        </button>
        <label className="reveal">
          <input
            type="checkbox"
            checked={reveal}
            onChange={(e) => setReveal(e.target.checked)}
          />
          민감 헤더 표시
        </label>
      </div>
      <div className="detail-body">
        {isTcp ? (
          <>
            <h4>Raw bytes {flow.comment ? `· ${flow.comment}` : ''}</h4>
            <pre className="body mono">{body || '(비어 있음)'}</pre>
            <h4>Hex</h4>
            <pre className="body mono">{toHex(body ?? '')}</pre>
          </>
        ) : (
          <>
            <h4>Headers</h4>
            <HeaderList headers={headers} />
            <h4>Body</h4>
            <pre className="body mono">{body || '(비어 있음)'}</pre>
          </>
        )}
      </div>
    </div>
  );
}

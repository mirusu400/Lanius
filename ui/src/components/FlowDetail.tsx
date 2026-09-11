import { useEffect, useState } from 'react';

import { getFlow } from '../api/client';
import type { FlowDetail, FlowSummary } from '../api/types';
import { formatUrl } from '../tabs/proxyModel';
import { sendToRepeater } from '../tabs/repeaterStore';

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
          Request
        </button>
        <button
          className={pane === 'response' ? 'active' : ''}
          onClick={() => setPane('response')}
        >
          Response {flow.status_code ? `(${flow.status_code})` : ''}
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
        <h4>Headers</h4>
        <HeaderList headers={headers} />
        <h4>Body</h4>
        <pre className="body mono">{body || '(비어 있음)'}</pre>
      </div>
    </div>
  );
}

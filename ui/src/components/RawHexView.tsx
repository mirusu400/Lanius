import { useEffect, useMemo, useState } from 'react';

import { getFlowBodyBytes } from '../api/client';
import { useT } from '../i18n';
import { HEX_LIMIT, hexPreview, hexPreviewBytes, splitMessage } from './bodyFormat';
import { MarkedText } from './MarkedText';
import { matchCount } from './searchHighlight';
import { LoadingPane } from './Spinner';
import { selectableTextProps } from './selectAllText';

const NOOP_MATCH_COUNT = () => {};

type HexResult = {
  key: string;
  text?: string;
  truncated?: number;
  error?: string;
};

function joinBytes(first: Uint8Array, second: Uint8Array): Uint8Array {
  const joined = new Uint8Array(first.length + second.length);
  joined.set(first);
  joined.set(second, first.length);
  return joined;
}

/**
 * Hex for a stored flow body.
 *
 * The start line and headers are reconstructed text because HTTP/2 framing
 * is not retained. The entity body, where charset evidence lives, is loaded
 * lazily from SQLite and is never decoded or re-encoded.
 */
export function RawHexView({
  flowId,
  side,
  raw,
  http,
  bodyBytes,
  bodyOmitted = false,
  query = '',
  activeIndex = null,
  onMatchCount = NOOP_MATCH_COUNT,
  className = 'body mono',
}: {
  flowId?: string;
  side?: 'request' | 'response';
  raw: string;
  http: boolean;
  bodyBytes?: number;
  bodyOmitted?: boolean;
  query?: string;
  activeIndex?: number | null;
  onMatchCount?: (count: number) => void;
  className?: string;
}) {
  const t = useT();
  const prefix = useMemo(() => {
    if (!http) return new Uint8Array();
    const { head, separator } = splitMessage(raw);
    return new TextEncoder().encode(`${head}${separator}`);
  }, [http, raw]);
  const [result, setResult] = useState<HexResult | null>(null);
  const key = `${flowId ?? ''}:${side ?? ''}:${http}:${bodyBytes ?? ''}:${bodyOmitted}:${prefix.length}:${raw}`;
  const prefixShown = useMemo(() => prefix.slice(0, HEX_LIMIT), [prefix]);
  const budget = HEX_LIMIT - prefixShown.length;
  const staticResult = useMemo<HexResult | null>(() => {
    if (!flowId || !side) return { key, ...hexPreview(raw) };
    if (bodyOmitted || budget <= 0 || bodyBytes === 0) {
      const total = prefix.length + (bodyOmitted ? 0 : (bodyBytes ?? 0));
      return { key, ...hexPreviewBytes(prefixShown, total || prefix.length) };
    }
    return null;
  }, [bodyBytes, bodyOmitted, budget, flowId, key, prefix.length, prefixShown, raw, side]);

  useEffect(() => {
    if (staticResult) return;
    let cancelled = false;
    const controller = new AbortController();
    getFlowBodyBytes(flowId!, side!, 0, budget, controller.signal)
      .then((bytes) => {
        if (cancelled) return;
        const shown = joinBytes(prefixShown, bytes.slice(0, budget));
        const totalBytes = prefix.length + (bodyBytes ?? bytes.length);
        setResult({ key, ...hexPreviewBytes(shown, totalBytes) });
      })
      .catch((cause: unknown) => {
        if (!cancelled && !(cause instanceof DOMException && cause.name === 'AbortError')) {
          setResult({ key, error: cause instanceof Error ? cause.message : String(cause) });
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [bodyBytes, budget, flowId, key, prefix.length, prefixShown, side, staticResult]);

  const ready = staticResult ?? (result?.key === key ? result : null);
  const matches = ready?.text ? matchCount(ready.text, query) : 0;
  useEffect(() => onMatchCount(matches), [matches, onMatchCount]);

  if (!ready) return <LoadingPane label={t('detail.hexLoading')} />;
  if (ready.error) return <p className="banner error">{ready.error}</p>;
  return <>
    <pre {...selectableTextProps} className={className}>
      <MarkedText text={ready.text || t('common.empty')} query={query} activeIndex={activeIndex} />
    </pre>
    {!!ready.truncated && <p className="muted">
      {t('detail.hexTruncated', { count: String(ready.truncated) })}
    </p>}
  </>;
}

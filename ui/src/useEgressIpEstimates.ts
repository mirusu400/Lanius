import { useEffect, useMemo, useRef, useState } from 'react';
import { getEgressIpEstimates } from './api/client';
import type { FlowSummary } from './api/types';

/** Read only the visible history page. No external observer request is made. */
export function useEgressIpEstimates(flows: FlowSummary[], enabled: boolean) {
  const page = useMemo(() => ({
    signatures: Object.fromEntries(flows.map((flow) => [flow.id,
      JSON.stringify([flow.started_at, flow.server_addr])])),
    ids: flows.map((flow) => flow.id),
  }), [flows]);
  const current = useRef(page);
  useEffect(() => { current.current = page; }, [page]);
  const [result, setResult] = useState<{
    signatures: Record<string, string>; values: Record<string, string | null>;
  } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let busy = false;
    const refresh = async () => {
      if (busy || !current.current.ids.length) return;
      const snapshot = current.current;
      busy = true;
      try {
        const values = await getEgressIpEstimates(snapshot.ids);
        if (!disposed) setResult({ signatures: snapshot.signatures, values });
      } catch {
        if (!disposed) setResult(null);
      } finally {
        busy = false;
      }
    };
    void refresh();
    // A fixed timer updates live rows even under continuous traffic and
    // picks up new observations. Hidden columns do no work.
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [enabled]);
  return Object.fromEntries(flows.map((flow) => [flow.id,
    enabled && result?.signatures[flow.id] === page.signatures[flow.id]
      ? result.values[flow.id] : null]));
}

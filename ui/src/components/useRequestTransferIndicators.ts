import { useCallback, useEffect, useState } from 'react';

import {
  subscribeRequestTransfers,
  type RequestTransferTool,
} from '../requestTransfers';

/** Tracks requests sent to a workspace that the user is not currently viewing. */
export function useRequestTransferIndicators(activeTab: string) {
  const [indicators, setIndicators] = useState<ReadonlySet<RequestTransferTool>>(
    () => new Set(),
  );

  useEffect(() => subscribeRequestTransfers((tool) => {
    if (tool === activeTab) return;
    setIndicators((current) => {
      if (current.has(tool)) return current;
      const next = new Set(current);
      next.add(tool);
      return next;
    });
  }), [activeTab]);

  const clearIndicator = useCallback((tool: RequestTransferTool) => {
    setIndicators((current) => {
      if (!current.has(tool)) return current;
      const next = new Set(current);
      next.delete(tool);
      return next;
    });
  }, []);

  return { indicators, clearIndicator };
}

/** Lets a tab tell the shell it is still loading.
 *
 * Doing this per tab would mean touching every one of them and getting
 * the placement right in each layout. Instead a tab reports that it is
 * busy and the shell draws one indicator, in one place, with one set of
 * rules about when a wait is long enough to be worth mentioning.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

interface BusyRegistry {
  /** Called by a tab while it is loading. */
  setBusy: (key: string, busy: boolean) => void;
}

const BusyContext = createContext<BusyRegistry | null>(null);

export function BusyProvider({
  children,
  onChange,
}: {
  children: React.ReactNode;
  onChange: (busy: boolean) => void;
}) {
  const [keys, setKeys] = useState<Set<string>>(() => new Set());

  const setBusy = useCallback((key: string, busy: boolean) => {
    setKeys((current) => {
      const has = current.has(key);
      if (busy === has) return current;
      const next = new Set(current);
      if (busy) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  // More than one thing can be loading at once, so the shell is busy
  // until all of them are done.
  useEffect(() => {
    onChange(keys.size > 0);
  }, [keys, onChange]);

  const value = useMemo(() => ({ setBusy }), [setBusy]);
  return <BusyContext.Provider value={value}>{children}</BusyContext.Provider>;
}

/** Report that this tab is loading. */
export function useReportBusy(key: string, busy: boolean): void {
  const registry = useContext(BusyContext);
  useEffect(() => {
    registry?.setBusy(key, busy);
    // Clear on unmount: a tab that is switched away from mid-load would
    // otherwise leave the indicator spinning forever.
    return () => registry?.setBusy(key, false);
  }, [registry, key, busy]);
}

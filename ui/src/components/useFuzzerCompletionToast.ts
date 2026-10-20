import { useCallback, useRef } from 'react';
import type { RunSummary } from '../api/types';
import { useT } from '../i18n';
import { useToast } from './Toast';

/** Owned by the workspace, whose subscription stays active across tab changes. */
export function useFuzzerCompletionToast() {
  const t = useT();
  const { showToast } = useToast();
  const seen = useRef(new Set<string>());
  return useCallback((run: RunSummary) => {
    if (run.status !== 'completed' && run.status !== 'stopped' && run.status !== 'failed') return;
    if (seen.current.has(run.id)) return;
    seen.current.add(run.id);
    if (seen.current.size > 256) seen.current.delete(seen.current.values().next().value!);
    const key = run.status === 'completed' ? 'toast.fuzzerCompleted'
      : run.status === 'stopped' ? 'toast.fuzzerStopped' : 'toast.fuzzerFailed';
    const message = t(key, { completed: run.completed, total: run.total });
    showToast({ message: run.status === 'failed' && run.error ? `${message} ${run.error}` : message,
      tone: run.status === 'failed' ? 'error' : run.status === 'stopped' ? 'info' : 'success',
      category: 'fuzzerRun', id: `fuzzer:${run.id}` });
  }, [showToast, t]);
}

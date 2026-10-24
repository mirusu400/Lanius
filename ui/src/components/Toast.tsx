import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';
import { subscribeRequestTransfers } from '../requestTransfers';
import { subscribeClipboardErrors } from '../clipboard';
import {
  loadToastPreferences, saveToastPreferences, TOAST_PREFERENCES_KEY,
  type ToastCategory, type ToastPreferences,
} from '../toastPreferences';
import { repeatsEngineConnectionError } from '../engineConnection';
import './Toast.css';

export type ToastTone = 'info' | 'success' | 'error';

export interface ToastOptions {
  message: string;
  tone?: ToastTone;
  durationMs?: number;
  category?: ToastCategory;
  /** Replaces the previous notification for the same operation. */
  id?: string;
}

interface ToastEntry extends ToastOptions {
  id: string;
  expiresAt: number | null;
}

interface ToastContextValue {
  showToast: (options: ToastOptions) => void;
  dismissToast: () => void;
  preferences: ToastPreferences;
  updatePreferences: (value: ToastPreferences) => boolean;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const entries = useRef(toasts);
  const [preferences, setPreferences] = useState(loadToastPreferences);
  const choices = useRef(preferences);

  const replace = useCallback((next: ToastEntry[]) => {
    entries.current = next;
    setToasts(next);
  }, []);

  const dismissToast = useCallback(() => {
    replace([]);
  }, [replace]);

  const applyPreferences = useCallback((next: ToastPreferences) => {
    choices.current = next;
    setPreferences(next);
    replace(entries.current.filter((toast) => toast.tone === 'error' || !toast.category || next[toast.category]));
  }, [replace]);

  const updatePreferences = useCallback((next: ToastPreferences) => {
    const persisted = saveToastPreferences(next);
    applyPreferences(next);
    return persisted;
  }, [applyPreferences]);

  useEffect(() => {
    const storage = (event: StorageEvent) => {
      if (event.key === TOAST_PREFERENCES_KEY || event.key === null) applyPreferences(loadToastPreferences());
    };
    window.addEventListener('storage', storage);
    return () => window.removeEventListener('storage', storage);
  }, [applyPreferences]);

  const showToast = useCallback((options: ToastOptions) => {
    // Errors (including Lockdown refusals) remain visible regardless of choices.
    if (options.tone !== 'error' && options.category && !choices.current[options.category]) return;
    // A transport failure already owns one persistent global banner. Keep
    // action-specific HTTP errors, but do not repeat the same fetch failure.
    if (options.tone === 'error'
      && document.querySelector('.app')
      && repeatsEngineConnectionError(options.message)) return;
    const id = options.id ?? `${options.category ?? options.tone}:${options.message}`;
    const now = Date.now();
    const next = entries.current.filter((toast) => toast.id !== id && (toast.expiresAt === null || toast.expiresAt > now));
    if (next.length >= 3) {
      const expendable = next.findIndex((toast) => toast.tone !== 'error');
      if (expendable < 0 && options.tone !== 'error') return;
      next.splice(expendable < 0 ? 0 : expendable, 1);
    }
    next.push({ ...options, id, expiresAt: options.durationMs === 0 ? null
      : now + (options.durationMs ?? (options.tone === 'error' ? 6000 : 3000)) });
    replace(next);
  }, [replace]);

  useEffect(() => subscribeRequestTransfers((tool) => {
    showToast({ message: t('toast.requestTransferred', { tool }), tone: 'success',
      category: tool === 'Replay' ? 'replay' : 'fuzzerTransfer' });
  }), [showToast, t]);

  useEffect(() => subscribeClipboardErrors((message) => {
    showToast({ message: t('clipboard.failed', { message }), tone: 'error' });
  }), [showToast, t]);

  useEffect(() => {
    const deadlines = toasts.flatMap((toast) => toast.expiresAt === null ? [] : [toast.expiresAt]);
    if (!deadlines.length) return;
    const timer = window.setTimeout(() => {
      replace(entries.current.filter((toast) => toast.expiresAt === null || toast.expiresAt > Date.now()));
    }, Math.max(0, Math.min(...deadlines) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [toasts, replace]);

  const value = useMemo(() => ({ showToast, dismissToast, preferences, updatePreferences }),
    [showToast, dismissToast, preferences, updatePreferences]);
  return <ToastContext.Provider value={value}>
    {children}
    <ToastViewport toasts={toasts} />
  </ToastContext.Provider>;
}

/** Render inside the active dialog so its live regions are not inert. A manual
 * popover also puts notifications above modal backdrops without taking focus. */
function ToastViewport({ toasts }: { toasts: ToastEntry[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [popover, setPopover] = useState(() => 'showPopover' in HTMLElement.prototype);
  const [host, setHost] = useState<HTMLElement>(document.body);
  useLayoutEffect(() => {
    const refresh = () => {
      // jsdom can deliver an already-queued mutation after its document has
      // been torn down; the desktop document remains present for app life.
      if (typeof document === 'undefined') return;
      const dialogs = document.querySelectorAll<HTMLDialogElement>('dialog[open]');
      const focused = document.activeElement?.closest<HTMLDialogElement>('dialog[open]');
      setHost(focused ?? dialogs[dialogs.length - 1] ?? document.body);
    };
    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (!popover || !ref.current) return;
    try {
      // Reinsert above a dialog that may have opened since the previous toast.
      ref.current.hidePopover();
      ref.current.showPopover();
    } catch {
      // oxlint-disable-next-line react/set-state-in-effect -- Synchronize with a webview whose popover API cannot be used.
      setPopover(false);
    }
  }, [popover, toasts, host]);
  return toasts.length ? createPortal(
    <div className="app-toasts" ref={ref} popover={popover ? 'manual' : undefined}>
      {toasts.map((toast) => <div key={toast.id} className={`app-toast ${toast.tone ?? 'info'}`}
        role={toast.tone === 'error' ? 'alert' : 'status'} aria-atomic="true">
        {toast.message}
      </div>)}
    </div>, host,
  ) : null;
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used within ToastProvider');
  return context;
}

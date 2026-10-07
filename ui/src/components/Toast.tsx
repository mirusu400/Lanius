import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useT } from '../i18n';
import { subscribeRequestTransfers } from '../requestTransfers';
import './Toast.css';

export type ToastTone = 'info' | 'success' | 'error';

export interface ToastOptions {
  message: string;
  tone?: ToastTone;
  durationMs?: number;
}

interface ToastContextValue {
  showToast: (options: ToastOptions) => void;
  dismissToast: () => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [toast, setToast] = useState<ToastOptions | null>(null);
  const timer = useRef<number | null>(null);

  const dismissToast = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setToast(null);
  }, []);

  const showToast = useCallback((options: ToastOptions) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    setToast(options);
    if (options.durationMs !== 0) {
      timer.current = window.setTimeout(() => {
        timer.current = null;
        setToast(null);
      }, options.durationMs ?? 4000);
    }
  }, []);

  useEffect(() => subscribeRequestTransfers((tool) => {
    showToast({ message: t('toast.requestTransferred', { tool }), tone: 'success' });
  }), [showToast, t]);

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  const value = useMemo(() => ({ showToast, dismissToast }), [showToast, dismissToast]);
  return <ToastContext.Provider value={value}>
    {children}
    {toast && <div className={`app-toast ${toast.tone ?? 'info'}`} role={toast.tone === 'error' ? 'alert' : 'status'}>
      {toast.message}
    </div>}
  </ToastContext.Provider>;
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used within ToastProvider');
  return context;
}

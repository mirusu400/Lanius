import { useCallback, useEffect, useRef } from 'react';
import { useT } from '../i18n';
import type { TranslationKey } from '../i18n/catalogue';
import { useToast } from './Toast';

/** Call only after applying a user edit, never from a settings load/refresh. */
export function useSettingsToast(section: TranslationKey) {
  const t = useT();
  const { showToast } = useToast();
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return useCallback((options: { persisted?: boolean; detail?: string; delayMs?: number } = {}) => {
    window.clearTimeout(timer.current);
    const notify = () => showToast({
      message: options.detail ? `${t(section)}: ${options.detail}`
        : t(options.persisted === false ? 'toast.settingsSessionOnly' : 'toast.settingsApplied', { section: t(section) }),
      tone: options.persisted === false || options.detail ? 'info' : 'success',
      category: 'settings', id: `settings:${section}`,
    });
    if (options.delayMs) timer.current = window.setTimeout(notify, options.delayMs);
    else notify();
  }, [showToast, t, section]);
}

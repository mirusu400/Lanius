import { addScopeRule } from '../api/client';
import type { ScopeRule } from '../api/types';
import { useT } from '../i18n';
import { useToast } from './Toast';

export type ScopeKind = 'include' | 'exclude';
export type ScopeTarget = 'hostname' | 'path';

/** Build an exact hostname rule, or a prefix rule for the selected path. */
export function requestScopeRule(url: string, kind: ScopeKind, target: ScopeTarget): Partial<ScopeRule> {
  const parsed = new URL(url);
  const protocol = parsed.protocol.slice(0, -1);
  if ((protocol !== 'http' && protocol !== 'https') || !parsed.hostname) {
    throw new Error('Invalid HTTP URL');
  }
  return {
    kind,
    host: parsed.hostname,
    path: target === 'hostname' ? '*' : `${parsed.pathname || '/'}*`,
    protocol: target === 'hostname' ? 'any' : protocol,
    port: target === 'hostname' ? null : Number(parsed.port || (protocol === 'https' ? 443 : 80)),
    match_type: 'glob',
    enabled: true,
  };
}

/** Save a menu rule and report its result in every request view. */
export function useAddRequestScopeRule() {
  const t = useT();
  const { showToast } = useToast();
  return async (url: string, kind: ScopeKind, target: ScopeTarget, onAdded?: () => void) => {
    try {
      await addScopeRule(requestScopeRule(url, kind, target));
      showToast({ message: t('menu.scopeRuleAdded'), tone: 'success' });
      onAdded?.();
    } catch (error) {
      showToast({ message: t('menu.scopeRuleFailed', { message: (error as Error).message }), tone: 'error' });
    }
  };
}

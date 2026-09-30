/** Controls Lanius-owned outbound traffic for this machine and project. */

import { useEffect, useState } from 'react';

import {
  getGlobalLockdown,
  getLockdown,
  isDesktop,
  restartProjectEngine,
  setGlobalLockdown,
  setProjectLockdown,
  setScopeEgress,
  type GlobalLockdownStatus,
  type LockdownStatus,
} from '../../api/client';
import { notifyLockdownChanged } from '../../lockdownEvents';
import { useT } from '../../i18n';
import { resetUpdates } from '../../updates';

export function LockdownSection() {
  const t = useT();
  const [status, setStatus] = useState<LockdownStatus | null>(null);
  const [global, setGlobal] = useState<GlobalLockdownStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    const [nextStatus, nextGlobal] = await Promise.all([getLockdown(), getGlobalLockdown()]);
    setStatus(nextStatus);
    setGlobal(nextGlobal);
    notifyLockdownChanged();
    if (nextStatus.effective) resetUpdates();
  };

  useEffect(() => {
    void refresh().catch((err: unknown) => setError(String(err)));
  }, []);

  const change = async (kind: 'global' | 'project' | 'scope-egress', enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (kind === 'global') await setGlobalLockdown(enabled);
      else if (kind === 'project') {
        await setProjectLockdown(enabled);
        if (enabled) await restartProjectEngine();
      } else await setScopeEgress(enabled);
      await refresh();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
      await refresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="lockdown-section">
      <h3>{t('lockdown.title')}</h3>
      <p className="muted">{t('lockdown.help')}</p>
      {status?.effective && <p className="lockdown-active">{t('lockdown.active')}</p>}
      {error && <div className="banner error" role="alert">{error}</div>}

      <div className="settings-row">
        <label className="lockdown-label">
          <input
            type="checkbox"
            checked={global?.enabled ?? false}
            disabled={!isDesktop() || busy || global === null || global.forced}
            onChange={(event) => void change('global', event.target.checked)}
          />{' '}
          {t('lockdown.global')}
        </label>
      </div>
      <p className="muted">{global?.forced ? t('lockdown.forced') : t('lockdown.globalHelp')}</p>

      <div className="settings-row">
        <label className="lockdown-label">
          <input
            type="checkbox"
            checked={status?.project_enabled ?? false}
            disabled={busy || status === null}
            onChange={(event) => void change('project', event.target.checked)}
          />{' '}
          {t('lockdown.project')}
        </label>
      </div>
      <p className="muted">{t('lockdown.projectHelp')}</p>

      <div className="settings-row">
        <label className="lockdown-label">
          <input
            type="checkbox"
            checked={status?.scope_egress_enabled ?? false}
            disabled={busy || status === null}
            onChange={(event) => void change('scope-egress', event.target.checked)}
          />{' '}
          {t('lockdown.scopeEgress')}
        </label>
      </div>
      <p className="muted">{t('lockdown.scopeEgressHelp')}</p>
      {status?.scope_egress_effective && (
        <p className="lockdown-active">{t('lockdown.scopeEgressActive')}</p>
      )}
    </section>
  );
}

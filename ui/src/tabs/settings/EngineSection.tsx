/** What the engine is doing and where its data lives. */

import { useEffect, useState } from 'react';

import { getStatus } from '../../api/client';
import type { EngineStatus } from '../../api/types';
import { useT } from '../../i18n';

export function EngineSection() {
  const t = useT();
  const [status, setStatus] = useState<EngineStatus | null>(null);

  useEffect(() => {
    getStatus().then(setStatus).catch(() => undefined);
  }, []);

  return (
    <section>
      <h3>{t('settings.proxySection')}</h3>
      {status ? (
        <dl className="settings-grid mono">
          <dt>{t('common.status')}</dt>
          <dd className={status.proxy.running ? 'status-2xx' : 'status-5xx'}>
            {status.proxy.running
              ? t('settings.running')
              : t('settings.stopped')}
          </dd>
          <dt>{t('common.address')}</dt>
          <dd>
            {status.proxy.host}:{status.proxy.port}
          </dd>
          <dt>{t('common.version')}</dt>
          <dd>{status.version}</dd>
          <dt>{t('settings.projectDb')}</dt>
          <dd>{status.db_path}</dd>
          <dt>{t('settings.capturedFlows')}</dt>
          <dd>{status.flows}</dd>
        </dl>
      ) : (
        <p className="muted">{t('settings.engineUnreachable')}</p>
      )}
    </section>
  );
}

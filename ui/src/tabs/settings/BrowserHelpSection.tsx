/** How to point a browser at the proxy by hand. */

import { useEffect, useState } from 'react';

import { getStatus } from '../../api/client';
import type { EngineStatus } from '../../api/types';
import { useT } from '../../i18n';

export function BrowserHelpSection() {
  const t = useT();
  const [status, setStatus] = useState<EngineStatus | null>(null);

  useEffect(() => {
    getStatus().then(setStatus).catch(() => undefined);
  }, []);

  const host = status?.proxy.host ?? '127.0.0.1';
  const port = status?.proxy.port ?? 8080;

  return (
    <section>
      <h3>{t('settings.browserSection')}</h3>
      <pre className="mono settings-code">
        {t('settings.browserHelp', { host, port })}
      </pre>
    </section>
  );
}

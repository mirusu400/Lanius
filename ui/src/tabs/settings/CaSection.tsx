/** The CA certificate a client has to trust to read HTTPS. */

import { useEffect, useState } from 'react';

import { caDownloadUrl, getCaInfo, type CaInfo } from '../../api/client';
import { useT } from '../../i18n';

/** Sentinel used to place a React node inside a translated sentence. */
const MARKER = '\u0000link\u0000';

/** Split a translated string around the marker, keeping the order the
 *  translation chose. */
function splitPlaceholder(text: string): string[] {
  return text.split(MARKER).flatMap((part, index) =>
    index === 0 ? [part] : [MARKER, part],
  );
}

export function CaSection({ onError }: { onError?: (message: string) => void }) {
  const t = useT();
  const [ca, setCa] = useState<CaInfo | null>(null);

  useEffect(() => {
    getCaInfo()
      .then(setCa)
      .catch((e) => onError?.((e as Error).message));
  }, [onError]);

  return (
    <section>
      <section>
        <h3>{t('settings.caSection')}</h3>
        <p className="muted">{t('settings.caHelp')}</p>
        {ca ? (
          <>
            <dl className="settings-grid mono">
              <dt>{t('common.location')}</dt>
              <dd>{ca.confdir}</dd>
              <dt>{t('common.proxy')}</dt>
              <dd>{ca.proxy}</dd>
            </dl>
            <div className="ca-downloads">
              {Object.entries(ca.available).map(([format, exists]) => (
                <a
                  key={format}
                  className={exists ? 'ca-link' : 'ca-link disabled'}
                  href={exists ? caDownloadUrl(format) : undefined}
                  download
                >
                  {t('settings.caDownload', { format })}
                </a>
              ))}
            </div>
            <p className="muted">
              {/* Split around {link} so the anchor lands wherever the
                  translation puts it. */}
              {splitPlaceholder(t('settings.caMitmit', { link: MARKER })).map(
                (part, index) =>
                  part === MARKER ? (
                    <a
                      key="mitmit"
                      href={ca.install_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      mitm.it
                    </a>
                  ) : (
                    <span key={index}>{part}</span>
                  ),
              )}
            </p>
          </>
        ) : (
          <p className="muted">{t('settings.caLoading')}</p>
        )}
      </section>
    </section>
  );
}

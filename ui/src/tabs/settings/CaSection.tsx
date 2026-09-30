/** The CA certificate a client has to trust to read HTTPS. */

import { useEffect, useState } from 'react';

import {
  downloadCaCertificate,
  getCaInfo,
  type CaInfo,
} from '../../api/client';
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

  const download = async (format: string) => {
    try {
      const blob = await downloadCaCertificate(format);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `mitmproxy-ca-cert.${format}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (error) {
      onError?.((error as Error).message);
    }
  };

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
                <button
                  key={format}
                  type="button"
                  className={exists ? 'ca-link' : 'ca-link disabled'}
                  disabled={!exists}
                  onClick={() => void download(format)}
                >
                  {t('settings.caDownload', { format })}
                </button>
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

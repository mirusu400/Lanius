import type { AnchorHTMLAttributes, MouseEvent } from 'react';

import { openUrl } from '@tauri-apps/plugin-opener';

import { isDesktop } from '../api/client';
import { useT } from '../i18n';
import { isExternalWebUrl } from './externalUrl';
import { useToast } from './Toast';

type ExternalLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  href?: string;
};

/** An ordinary link in a browser, and an OS-default-browser link in Tauri. */
export function ExternalLink({
  href,
  onClick,
  target = '_blank',
  rel = 'noopener noreferrer',
  ...props
}: ExternalLinkProps) {
  const t = useT();
  const { showToast } = useToast();

  const click = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      !isDesktop() ||
      !isExternalWebUrl(href)
    ) {
      return;
    }

    // A Tauri WebView does not turn target="_blank" into an OS browser
    // window. The opener plugin does, using the user's configured default.
    event.preventDefault();
    void openUrl(href).catch((error) => {
      showToast({
        message: t('externalLink.openFailed', {
          message: error instanceof Error ? error.message : String(error),
        }),
        tone: 'error',
      });
    });
  };

  return <a href={href} target={target} rel={rel} onClick={click} {...props} />;
}

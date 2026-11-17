/** Opens a browser that is already pointed at the proxy.
 *
 * Sits next to the history because that is where a user decides they want
 * traffic to look at, rather than buried in Settings.
 */
import { useState } from 'react';

import { useT } from '../i18n';
import { BrowserLaunchDialog } from './BrowserLaunchDialog';
import { useToast } from './Toast';

/** A globe, drawn rather than typed.
 *
 * The emoji globe renders at a different size and colour on every
 * platform, and as a colour glyph it ignores the button's text colour.
 * currentColor keeps it consistent with the label beside it.
 */
function GlobeIcon() {
  return (
    <svg
      className="button-icon"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="6.4" />
      <path d="M1.6 8h12.8" />
      <ellipse cx="8" cy="8" rx="3" ry="6.4" />
    </svg>
  );
}

export function OpenBrowserButton() {
  const t = useT();
  const { showToast } = useToast();
  const [chooseOpen, setChooseOpen] = useState(false);

  return (
    <div className="open-browser-action">
      <button
        type="button"
        title={t('browser.help')}
        onClick={() => setChooseOpen(true)}
      >
        <GlobeIcon />
        {t('browser.open')}
      </button>
      <BrowserLaunchDialog
        open={chooseOpen}
        onClose={() => setChooseOpen(false)}
        onLaunched={(launched) => {
          showToast({ message: `${t('browser.section')}: ${t('browser.opened', { name: launched.name })}`, tone: 'success', category: 'browser' });
        }}
      />
    </div>
  );
}

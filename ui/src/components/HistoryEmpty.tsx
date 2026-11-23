/** What an empty history table says, depending on why it is empty.
 *
 * "No traffic captured yet" under a filter that matches nothing made people
 * think capture was broken; with no traffic at all, it named a port that
 * might not be the listener and offered no way to get traffic flowing.
 */
import { openDocsPage } from '../docs/navigation';
import { useT } from '../i18n';
import { OpenBrowserButton } from './OpenBrowserButton';

export function HistoryEmpty({ filtered, olderPage, proxyAddress, onClearFilters }: {
  /** A search or filter is narrowing the list. */
  filtered: boolean;
  /** Showing a page past the newest one. */
  olderPage: boolean;
  /** The primary listener, once the engine status has loaded. */
  proxyAddress?: string;
  onClearFilters: () => void;
}) {
  const t = useT();
  if (filtered) {
    return (
      <div className="history-empty">
        <p>{t('proxy.emptyFiltered')}</p>
        <div className="history-empty-actions">
          <button type="button" onClick={onClearFilters}>{t('proxy.clearFilters')}</button>
        </div>
      </div>
    );
  }
  if (olderPage) return <div className="history-empty"><p>{t('proxy.emptyOlderPage')}</p></div>;
  return (
    <div className="history-empty">
      <p>{t('proxy.emptyNoTraffic')}</p>
      <p className="muted">
        {proxyAddress
          ? t('proxy.emptyNoTrafficHelp', { proxy: proxyAddress })
          : t('proxy.emptyNoTrafficHelpNoAddress')}
      </p>
      <div className="history-empty-actions">
        <OpenBrowserButton />
        <button type="button" className="link-button" onClick={() => openDocsPage('guide:browser')}>
          {t('proxy.setupGuide')}
        </button>
      </div>
    </div>
  );
}

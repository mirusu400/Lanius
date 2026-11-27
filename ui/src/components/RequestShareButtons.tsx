import { useT } from '../i18n';
import { formatShortcut, getShortcut } from '../shortcuts';

function withShortcut(label: string, id: string): string {
  const binding = getShortcut(id);
  return binding ? `${label} (${formatShortcut(binding)})` : label;
}

/** Export and Import beside the editor's search buttons, drawn the same way. */
export function RequestShareButtons({
  onExport,
  onImport,
}: {
  onExport: () => void;
  onImport: () => void;
}) {
  const t = useT();
  return <div className="message-search-toggles">
    <button
      type="button"
      className="message-search-toggle"
      onClick={onExport}
      aria-label={t('replay.export')}
      title={withShortcut(t('replay.exportHelp'), 'replay.export')}
    >
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M10 12.5V2.5M6.5 6 10 2.5 13.5 6" />
        <path d="M3 11v4.5A1.5 1.5 0 0 0 4.5 17h11a1.5 1.5 0 0 0 1.5-1.5V11" />
      </svg>
    </button>
    <button
      type="button"
      className="message-search-toggle"
      onClick={onImport}
      aria-label={t('replay.import')}
      title={withShortcut(t('replay.importHelp'), 'replay.import')}
    >
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M10 2.5v10M6.5 9 10 12.5 13.5 9" />
        <path d="M3 11v4.5A1.5 1.5 0 0 0 4.5 17h11a1.5 1.5 0 0 0 1.5-1.5V11" />
      </svg>
    </button>
  </div>;
}

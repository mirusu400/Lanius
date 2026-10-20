import { useT } from '../i18n';

export function CodeDisplayControls({ showLineEndings, onShowLineEndings, wrap, onWrap, disabled = false }: {
  showLineEndings: boolean;
  onShowLineEndings: (show: boolean) => void;
  wrap: boolean;
  onWrap: (wrap: boolean) => void;
  disabled?: boolean;
}) {
  const t = useT();
  return <div className="code-display-controls">
    <button type="button" className="code-display-toggle" aria-label={t('body.showLineEndings')}
      title={t('body.showLineEndings')} aria-pressed={showLineEndings} disabled={disabled}
      onClick={() => onShowLineEndings(!showLineEndings)}>
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M11 16V4H8a4 4 0 0 0 0 8h3M15 4v12M9 4h8" />
      </svg>
    </button>
    <button type="button" className="code-display-toggle" aria-label={t('body.wrap')}
      title={t('body.wrap')} aria-pressed={wrap} disabled={disabled}
      onClick={() => onWrap(!wrap)}>
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 5h14M3 9h11a3 3 0 0 1 0 6h-4m2-2-2 2 2 2M3 13h3" />
      </svg>
    </button>
  </div>;
}

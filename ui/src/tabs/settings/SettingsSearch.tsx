import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { searchSettings, type SettingsSection } from './settingsCatalogue';

export function SettingsSearch({ onSelect }: { onSelect: (section: SettingsSection) => void }) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const resultsId = useId();
  const results = useMemo(() => searchSettings(query), [query]);
  const expanded = open && query.trim() !== '';
  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const dismiss = () => setOpen(false);
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('blur', dismiss);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('blur', dismiss);
    };
  }, [expanded]);
  const select = (section: SettingsSection) => {
    setQuery('');
    setOpen(false);
    onSelect(section);
  };

  return <div className="settings-search" ref={rootRef} onBlur={(event) => {
    // WebKit mouse clicks can blur the input with no relatedTarget before
    // the result's click fires. Pointer dismissal handles that case safely.
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <div className="settings-search-field">
      <span className="settings-search-icon" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="8" cy="8" r="5.5" /><path d="m12 12 5 5" /></svg></span>
      <input ref={inputRef} type="search" aria-label={t('settings.search.label')}
        placeholder={t('settings.search.placeholder')} value={query}
        aria-expanded={expanded} aria-controls={expanded ? resultsId : undefined}
        onFocus={() => setOpen(true)}
        onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (event.key === 'Escape') { event.preventDefault(); setOpen(false); }
          if (event.key === 'ArrowDown' && expanded && results.length) {
            event.preventDefault(); resultsRef.current?.querySelector('button')?.focus();
          }
          if (event.key === 'Enter' && expanded && results.length) {
            event.preventDefault(); select(results[0]);
          }
        }} />
      {query && <button type="button" className="settings-search-clear" aria-label={t('settings.search.clear')}
        onClick={() => { setQuery(''); inputRef.current?.focus(); }}>×</button>}
    </div>
    {expanded && <div className="settings-search-results" id={resultsId} ref={resultsRef}
      role="region" aria-label={t('settings.search.results')}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault(); inputRef.current?.focus(); setOpen(false);
        }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        const buttons = [...event.currentTarget.querySelectorAll('button')];
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        event.preventDefault();
        if (event.key === 'ArrowUp' && at === 0) inputRef.current?.focus();
        else buttons[Math.max(0, Math.min(buttons.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
      }}>
      <p className="settings-search-count muted" role="status">{results.length
        ? t('settings.search.count', { count: results.length }) : t('settings.search.empty')}</p>
      {results.length > 0 && <ul>
        {results.map((section) => <li key={section.id}>
          <button type="button" aria-label={`${t(`settings.group.${section.group}`)} → ${t(section.title)}`} onClick={() => select(section)}>
            <span className="settings-search-title">{t(section.title)}</span>
            <span className="settings-search-path">{t(`settings.group.${section.group}`)} <span aria-hidden="true">→</span> {t(section.title)}</span>
          </button>
        </li>)}
      </ul>}
    </div>}
  </div>;
}

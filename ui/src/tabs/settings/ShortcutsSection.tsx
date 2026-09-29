import { useEffect, useState } from 'react';

import { useT } from '../../i18n';
import {
  formatShortcut,
  getShortcut,
  resetShortcut,
  sameShortcut,
  saveShortcut,
  shortcutFromEvent,
  SHORTCUTS,
  type KeyboardShortcut,
} from '../../shortcuts';

export function ShortcutsSection() {
  const t = useT();
  const [bindings, setBindings] = useState<Record<string, KeyboardShortcut | null>>(
    () => Object.fromEntries(SHORTCUTS.map(({ id }) => [id, getShortcut(id)])),
  );
  const [capturing, setCapturing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!capturing) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setCapturing(null);
        setError(null);
        return;
      }

      const candidate = shortcutFromEvent(event);
      if (!candidate) {
        if (!event.ctrlKey && !event.altKey && !event.metaKey) {
          event.preventDefault();
          event.stopPropagation();
          setError(t('shortcuts.requireModifier'));
        }
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      const conflict = SHORTCUTS.find(
        ({ id }) => id !== capturing && sameShortcut(getShortcut(id), candidate),
      );
      if (conflict) {
        setError(t('shortcuts.conflict', {
          shortcut: formatShortcut(candidate),
          action: t(conflict.label),
        }));
        return;
      }

      saveShortcut(capturing, candidate);
      setBindings((current) => ({ ...current, [capturing]: candidate }));
      setCapturing(null);
      setError(null);
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [capturing, t]);

  const clear = (id: string) => {
    saveShortcut(id, null);
    setBindings((current) => ({ ...current, [id]: null }));
    setCapturing(null);
    setError(null);
  };

  const reset = (id: string) => {
    resetShortcut(id);
    setBindings((current) => ({ ...current, [id]: getShortcut(id) }));
    setCapturing(null);
    setError(null);
  };

  return (
    <section>
      <h3>{t('shortcuts.section')}</h3>
      <p className="muted">{t('shortcuts.help')}</p>
      {(['general', 'navigation', 'repeater'] as const).map((category) => (
        <div className="shortcut-group" key={category}>
          <h4>{t(`shortcuts.group.${category}`)}</h4>
          <div className="shortcut-list">
            {SHORTCUTS.filter((definition) => definition.category === category).map(
              (definition) => {
                const binding = bindings[definition.id] ?? null;
                const isCapturing = capturing === definition.id;
                return (
                  <div className="shortcut-row" key={definition.id}>
                    <div className="shortcut-info">
                      <strong>{t(definition.label)}</strong>
                      {definition.description && (
                        <span className="muted">{t(definition.description)}</span>
                      )}
                    </div>
                    <button
                      type="button"
                      className="shortcut-bind mono"
                      aria-pressed={isCapturing}
                      data-shortcut-recording={isCapturing}
                      onClick={() => {
                        setError(null);
                        setCapturing(isCapturing ? null : definition.id);
                      }}
                    >
                      {isCapturing
                        ? t('shortcuts.pressKeys')
                        : formatShortcut(binding)}
                    </button>
                    <button
                      type="button"
                      onClick={() => clear(definition.id)}
                      disabled={!binding}
                    >
                      {t('shortcuts.clear')}
                    </button>
                    <button type="button" onClick={() => reset(definition.id)}>
                      {t('shortcuts.reset')}
                    </button>
                  </div>
                );
              },
            )}
          </div>
        </div>
      ))}
      {capturing && <p className="muted">{t('shortcuts.recordingHelp')}</p>}
      {error && <div className="banner error">{error}</div>}
    </section>
  );
}

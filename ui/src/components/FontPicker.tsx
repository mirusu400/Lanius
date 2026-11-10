/** Pick any installed font, or type a family name.
 *
 * A fixed dropdown only ever offered a handful of fonts, most of which
 * a given machine did not have. This lists what is actually installed,
 * each drawn in itself, and filters as you type. A name that is not in
 * the list can still be used, for a font the list could not read.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { cleanFamily, fontStack } from '../appearance';
import { useT } from '../i18n';
import { listSystemFonts, type SystemFont } from './systemFonts';

/** Enough to find a font by scrolling; past this, typing is quicker. */
const MAX_SHOWN = 400;

interface Option {
  family: string;
  label: string;
  /** Starts a group, drawn with a heading above it. */
  heading?: string;
}

export function FontPicker({
  id,
  value,
  fallback,
  suggestions,
  preferMonospaced = false,
  onChange,
}: {
  id: string;
  /** The chosen family; empty for the default. */
  value: string;
  /** The stack used for the default and behind every choice. */
  fallback: string;
  /** Offered when the installed fonts cannot be listed. */
  suggestions: readonly string[];
  /** List fixed-width fonts first, for the editor font. */
  preferMonospaced?: boolean;
  onChange: (family: string) => void;
}) {
  const t = useT();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value);
  // Opening shows the whole list; only typing narrows it.
  const [filtering, setFiltering] = useState(false);
  const [active, setActive] = useState(-1);
  const [fonts, setFonts] = useState<SystemFont[] | null>(null);
  const [failed, setFailed] = useState(false);

  // Follow a value changed elsewhere, such as Reset to defaults.
  const [seenValue, setSeenValue] = useState(value);
  if (seenValue !== value) {
    setSeenValue(value);
    setText(value);
  }

  // Loaded on first open rather than on mount: scanning takes a moment,
  // and most visits to Settings never open the picker.
  useEffect(() => {
    if (!open || fonts !== null) return;
    let live = true;
    listSystemFonts()
      .then((list) => {
        if (live) setFonts(list);
      })
      .catch(() => {
        if (!live) return;
        setFailed(true);
        setFonts([]);
      });
    return () => {
      live = false;
    };
  }, [open, fonts]);

  const options = useMemo<Option[]>(() => {
    const installed = fonts && fonts.length > 0
      ? fonts
      : suggestions.map((family) => ({ family, monospaced: false }));
    const query = filtering ? text.trim().toLowerCase() : '';
    const matching = installed.filter((font) => font.family.toLowerCase().includes(query));
    const result: Option[] = [];
    if (!query) result.push({ family: '', label: t('appearance.fontDefault') });
    const mono = preferMonospaced ? matching.filter((font) => font.monospaced) : [];
    const rest = preferMonospaced ? matching.filter((font) => !font.monospaced) : matching;
    mono.forEach((font, index) => result.push({
      family: font.family,
      label: font.family,
      heading: index === 0 ? t('appearance.fontsMonospaced') : undefined,
    }));
    rest.forEach((font, index) => result.push({
      family: font.family,
      label: font.family,
      heading: index === 0 && mono.length > 0 ? t('appearance.fontsOther') : undefined,
    }));
    return result.slice(0, MAX_SHOWN);
  }, [fonts, suggestions, filtering, text, preferMonospaced, t]);

  // Keep the highlighted row in view while moving with the keyboard.
  useEffect(() => {
    if (active < 0) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  const choose = (family: string) => {
    const clean = cleanFamily(family);
    // Use the installed spelling, so "menlo" becomes "Menlo".
    const known = fonts?.find((font) => font.family.toLowerCase() === clean.toLowerCase());
    const next = known?.family ?? clean;
    setText(next);
    setOpen(false);
    setFiltering(false);
    setActive(-1);
    if (next !== value) onChange(next);
  };

  const show = () => {
    setOpen(true);
    setFiltering(false);
    const index = options.findIndex((option) => option.family === value);
    setActive(index);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        show();
        return;
      }
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((index) => Math.max(0, Math.min(options.length - 1, index + step)));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (open && active >= 0 && options[active]) choose(options[active].family);
      else choose(text);
    } else if (event.key === 'Escape') {
      if (!open) return;
      event.preventDefault();
      // Escape backs out of the edit as well as the list.
      setText(value);
      setOpen(false);
      setFiltering(false);
    }
  };

  const activeId = open && active >= 0 ? `${listId}-${active}` : undefined;

  return (
    <span className="font-picker">
      <input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        autoComplete="off"
        spellCheck={false}
        placeholder={t('appearance.fontDefault')}
        value={text}
        style={{ fontFamily: fontStack(text, fallback) }}
        onFocus={show}
        onClick={() => {
          if (!open) show();
        }}
        onChange={(event) => {
          setText(event.target.value);
          setFiltering(true);
          setOpen(true);
          setActive(-1);
        }}
        onBlur={() => {
          if (open || text !== value) choose(text);
        }}
        onKeyDown={onKeyDown}
      />
      {open && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          className="font-picker-list"
          // Keeps focus in the field, so picking with the mouse does not
          // first blur it and commit the half-typed text.
          onMouseDown={(event) => event.preventDefault()}
        >
          {fonts === null && (
            <li className="font-picker-note muted">{t('appearance.fontsLoading')}</li>
          )}
          {failed && (
            <li className="font-picker-note muted">{t('appearance.fontsUnavailable')}</li>
          )}
          {options.map((option, index) => (
            <li
              key={`${option.family}-${index}`}
              role="presentation"
            >
              {option.heading && (
                <div className="font-picker-heading muted" aria-hidden="true">{option.heading}</div>
              )}
              <div
                id={`${listId}-${index}`}
                data-index={index}
                role="option"
                aria-selected={option.family === value}
                className={index === active ? 'font-picker-option active' : 'font-picker-option'}
                style={{ fontFamily: fontStack(option.family, fallback) }}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(option.family)}
              >
                {option.label}
              </div>
            </li>
          ))}
          {filtering && text.trim() && options.length === 0 && (
            <li className="font-picker-note muted">
              {t('appearance.fontsNoMatch', { name: cleanFamily(text) })}
            </li>
          )}
        </ul>
      )}
    </span>
  );
}

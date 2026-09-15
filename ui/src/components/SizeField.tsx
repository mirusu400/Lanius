/** A font size: type an exact number, or pick from a list.
 *
 * A slider makes it easy to land near a size and hard to land on one,
 * which matters because the difference between 12 and 13 is the whole
 * decision. This takes a typed number and offers the usual values, so
 * both ways work.
 *
 * A real select rather than a datalist: this runs in a WebKit webview in
 * the desktop build, where datalist support is patchy enough that the
 * list can simply not appear.
 */

import { useEffect, useState } from 'react';

export function SizeField({
  id,
  value,
  min,
  max,
  presets,
  label,
  onChange,
}: {
  id: string;
  value: number;
  min: number;
  max: number;
  /** The sizes offered in the dropdown. */
  presets: readonly number[];
  /** Describes the dropdown for a screen reader. */
  label: string;
  onChange: (size: number) => void;
}) {
  // Held separately so a half-typed number is not clamped on every
  // keystroke: typing "1" on the way to "16" would otherwise jump to the
  // minimum and eat the next digit.
  const [text, setText] = useState(String(value));

  useEffect(() => {
    setText(String(value));
  }, [value]);

  const commit = (raw: string) => {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) {
      setText(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, parsed));
    setText(String(clamped));
    onChange(clamped);
  };

  return (
    <span className="size-field">
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          // Apply as you type once the value is usable, so the preview
          // keeps up, but leave the text alone until focus leaves.
          const parsed = Number.parseInt(event.target.value, 10);
          if (!Number.isNaN(parsed) && parsed >= min && parsed <= max) {
            onChange(parsed);
          }
        }}
        onBlur={(event) => commit(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit(event.currentTarget.value);
        }}
      />
      <span className="muted">px</span>
      <select
        aria-label={label}
        // A size typed by hand may not be one of the presets, so the
        // dropdown shows no selection rather than claiming a wrong one.
        value={presets.includes(value) ? String(value) : ''}
        onChange={(event) => commit(event.target.value)}
      >
        {!presets.includes(value) && <option value="">{value}</option>}
        {presets.map((size) => (
          <option key={size} value={size}>
            {size}
          </option>
        ))}
      </select>
    </span>
  );
}

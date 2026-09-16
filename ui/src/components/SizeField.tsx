/** A font size: type an exact number, or pick from the usual ones.
 *
 * A slider makes it easy to land near a size and hard to land on one,
 * which matters because the difference between 12 and 13 is the whole
 * decision.
 *
 * One control rather than a box beside a dropdown. A datalist is exactly
 * this: a text field that also offers suggestions. It was split in two
 * on an assumption that the WebKit webview the desktop build uses would
 * not draw the picker; tested in WKWebView, it does, on number inputs as
 * well as text.
 */

import { useEffect, useState } from 'react';

export function SizeField({
  id,
  value,
  min,
  max,
  presets,
  onChange,
}: {
  id: string;
  value: number;
  min: number;
  max: number;
  /** The sizes offered alongside the field. */
  presets: readonly number[];
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
        list={`${id}-presets`}
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
      <datalist id={`${id}-presets`}>
        {presets.map((size) => (
          <option key={size} value={size} />
        ))}
      </datalist>
      <span className="muted">px</span>
    </span>
  );
}

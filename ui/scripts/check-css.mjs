/** Guards two CSS rules that cannot be checked in jsdom.
 *
 * jsdom does not resolve custom properties or `font: inherit`, so a test
 * that mounts a button and measures it reports "medium" whatever the CSS
 * says. The behaviour was verified in a real browser; this keeps the
 * source rules that produce it from being removed by accident.
 */

import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/App.css', import.meta.url), 'utf8');
const problems = [];

// Form controls do not inherit font by default, so without this the
// interface size setting resizes the text around buttons and inputs and
// leaves them at the browser's own size.
if (
  !/button,\s*\n\s*input,\s*\n\s*select,\s*\n\s*textarea\s*\{[^}]*font:\s*inherit/m.test(
    css,
  )
) {
  problems.push('form controls no longer inherit the interface font');
}

// A fixed padding leaves a large label crammed into a small button.
const shared = css.match(/(^|\})\s*button\s*\{([^}]*)\}/m);
if (!shared || !/padding:\s*[\d.]+em/.test(shared[2])) {
  problems.push('the shared button rule no longer sizes its padding in em');
}

// Anything in px ignores the size setting. The two custom properties are
// where the sizes are allowed to be absolute.
const fixed = [...css.matchAll(/font-size:\s*\d+px/g)].map((m) => m[0]);
if (fixed.length > 0) {
  problems.push(`font sizes that ignore the setting: ${fixed.join(', ')}`);
}

// Tab rows sit on a bottom border, so a button whose height works out to
// a fraction of a pixel loses its last row to rounding when the row has
// no padding under it. WebKit is stricter about this than Chrome, which
// is why it showed up in the desktop build first.
const subtabs = css.match(/(^|\})\s*\.subtabs\s*\{([^}]*)\}/m);
if (!subtabs || /padding:[^;]*\s0(px)?;/.test(subtabs[2])) {
  problems.push('.subtabs has no room under its buttons, so they get clipped');
}

// A horizontal scroller clips vertically too, which takes the underline
// off the active tab.
const tabs = css.match(/(^|\})\s*\.tabs\s*\{([^}]*)\}/m);
if (tabs && /overflow-x:\s*auto/.test(tabs[2]) && !/overflow-y:\s*hidden/.test(tabs[2])) {
  problems.push('.tabs scrolls sideways without saying what happens vertically');
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`css: ${problem}`);
  process.exit(1);
}

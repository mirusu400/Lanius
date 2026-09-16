/** Reformatting a body so it can be read and edited.
 *
 * A captured JSON body arrives as one long line, which is unreadable and
 * worse to edit. Laying it out is nearly always what you want, so it is
 * the default, with the exact bytes one click away.
 *
 * The rule throughout: only reformat what is definitely JSON. A body
 * that is not JSON, or is JSON with a mistake in it, is passed through
 * untouched. Half-formatting a body would corrupt the very thing the
 * user is trying to look at.
 */

/** How a body is being shown. */
export type BodyView = 'pretty' | 'raw';

/** Two spaces: deep JSON runs out of width quickly at four. */
const INDENT = 2;

/** Is this worth offering to reformat?
 *
 * Judged by parsing it, not by the content type: plenty of APIs send
 * JSON as text/plain, and plenty of things labelled JSON are not.
 */
export function isFormattable(body: string): boolean {
  const trimmed = body.trim();
  // A bare number or string is valid JSON but has nothing to lay out,
  // and reformatting it would only strip whitespace for no gain.
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/** The body laid out over several lines, if it can be. */
export function prettify(body: string): string {
  if (!isFormattable(body)) return body;
  try {
    return JSON.stringify(JSON.parse(body), null, INDENT);
  } catch {
    return body;
  }
}

/** The body on one line, the way it went over the wire. */
export function minify(body: string): string {
  if (!isFormattable(body)) return body;
  try {
    return JSON.stringify(JSON.parse(body));
  } catch {
    return body;
  }
}

/** The body as the chosen view shows it. */
export function formatBody(body: string, view: BodyView): string {
  return view === 'pretty' ? prettify(body) : body;
}

/**
 * Has laying this body out actually changed anything?
 *
 * Used to decide whether the choice is worth offering: a body that is
 * already laid out, or cannot be, should not grow a control that does
 * nothing.
 */
export function canReformat(body: string): boolean {
  return isFormattable(body) && prettify(body) !== body;
}

/** Split raw HTTP text into its head and its body.
 *
 * The blank line is the separator HTTP defines. Returning the exact
 * separator that was found, rather than assuming one, keeps a request
 * written with bare newlines from being silently rewritten to CRLF.
 */
export function splitMessage(text: string): {
  head: string;
  separator: string;
  body: string;
} {
  const match = text.match(/\r?\n\r?\n/);
  if (!match || match.index === undefined) {
    return { head: text, separator: '', body: '' };
  }
  return {
    head: text.slice(0, match.index),
    separator: match[0],
    body: text.slice(match.index + match[0].length),
  };
}

/** Reformat only the body of a raw HTTP message, leaving the head alone.
 *
 * Rewriting the whole message would reorder or reindent headers, which
 * are not JSON and are often the thing being tested.
 */
export function formatMessageBody(text: string, view: BodyView): string {
  const { head, separator, body } = splitMessage(text);
  if (!separator) return text;
  return `${head}${separator}${formatBody(body, view)}`;
}

/** Whether a raw HTTP message has a body worth reformatting. */
export function messageCanReformat(text: string): boolean {
  return canReformat(splitMessage(text).body);
}

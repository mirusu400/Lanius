export const LARGE_TEXT_THRESHOLD = 64 * 1024;

export type TextDocumentTask = { kind: 'document'; text: string } | { kind: 'search'; text: string; query: string };
export type TextDocumentResult = { lines: string[] } | { starts: Uint32Array };

/** Only LF is structural. Retain CR (including CRLF) in the document so
 * selection offsets and clipboard text remain identical to captured text. */
export function prepareTextDocument(task: TextDocumentTask): TextDocumentResult {
  if (task.kind === 'document') return { lines: task.text.split('\n') };
  if (!task.query) return { starts: new Uint32Array() };
  const expression = new RegExp(task.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  let starts = new Uint32Array(1024), size = 0;
  for (const match of task.text.matchAll(expression)) {
    if (size === starts.length) {
      const next = new Uint32Array(starts.length * 2);
      next.set(starts);
      starts = next;
    }
    starts[size++] = match.index;
  }
  return { starts: starts.slice(0, size) };
}

import { Text } from '@codemirror/state';
import { textDocumentCache } from './textDocumentCache';
import { runTextDocumentTask } from './textDocumentTask';

export async function prepareCachedTextDocument(text: string, signal: AbortSignal): Promise<Text> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const cached = textDocumentCache.get(text);
  if (cached) return cached;
  const generation = textDocumentCache.generation;
  const result = await runTextDocumentTask({ kind: 'document', text }, signal);
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  if (!('lines' in result)) throw new Error('Missing prepared document');
  const doc = Text.of(result.lines);
  textDocumentCache.put(text, doc, generation);
  return doc;
}

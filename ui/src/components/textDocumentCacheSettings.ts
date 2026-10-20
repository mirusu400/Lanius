import { DEFAULT_DOCUMENT_CACHE_MIB, MAX_DOCUMENT_CACHE_MIB, textDocumentCache } from './textDocumentCache';

export interface TextDocumentCacheSettings { limitMiB: number }

export function getTextDocumentCacheSettings(): TextDocumentCacheSettings {
  return { limitMiB: textDocumentCache.getSnapshot().maxBytes / (1024 * 1024) };
}

export function restoreTextDocumentCacheSettings(value: unknown): void {
  textDocumentCache.clear();
  const limit = value && typeof value === 'object' && 'limitMiB' in value ? value.limitMiB : undefined;
  textDocumentCache.setLimitMiB(typeof limit === 'number' && Number.isInteger(limit) && limit >= 0 && limit <= MAX_DOCUMENT_CACHE_MIB
    ? limit : DEFAULT_DOCUMENT_CACHE_MIB);
}

export function resetTextDocumentCacheSettings(): void {
  textDocumentCache.clear();
  textDocumentCache.setLimitMiB(DEFAULT_DOCUMENT_CACHE_MIB);
}

/** Usage and LRU changes must never schedule settings writes. */
export function subscribeTextDocumentCacheSettings(listener: (value: TextDocumentCacheSettings) => void): () => void {
  let previous = getTextDocumentCacheSettings();
  listener(previous);
  return textDocumentCache.subscribe(() => {
    const next = getTextDocumentCacheSettings();
    if (previous.limitMiB === next.limitMiB) return;
    previous = next;
    listener(next);
  });
}

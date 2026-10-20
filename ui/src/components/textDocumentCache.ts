import type { Text } from '@codemirror/state';

export const DEFAULT_DOCUMENT_CACHE_MIB = 32;
export const MAX_DOCUMENT_CACHE_MIB = 1024;
const MIB = 1024 * 1024;

export interface TextDocumentCacheStats { bytes: number; count: number; maxBytes: number }

/** Immutable documents only: never retain a view, DOM, selection or search.
 * Content keys also distinguish decoding/formatting changes without relying
 * on flow IDs or response metadata that may be reused during capture. */
export class TextDocumentCache {
  private entries = new Map<string, { doc: Text; bytes: number }>();
  private bytes = 0;
  private epoch = 0;
  private maxBytes: number;
  private maxEntries: number;
  private listeners = new Set<() => void>();
  private snapshot: TextDocumentCacheStats;

  constructor(maxBytes = DEFAULT_DOCUMENT_CACHE_MIB * MIB, maxEntries = 8) {
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.snapshot = { bytes: 0, count: 0, maxBytes };
  }

  get generation() { return this.epoch; }
  getSnapshot = (): TextDocumentCacheStats => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(): void {
    if (this.snapshot.bytes === this.bytes && this.snapshot.count === this.entries.size && this.snapshot.maxBytes === this.maxBytes) return;
    this.snapshot = { bytes: this.bytes, count: this.entries.size, maxBytes: this.maxBytes };
    for (const listener of this.listeners) listener();
  }

  private evictOldest(): void {
    const oldest = this.entries.keys().next().value!;
    this.bytes -= this.entries.get(oldest)!.bytes;
    this.entries.delete(oldest);
  }

  setLimitMiB(limit: number): void {
    if (!Number.isInteger(limit) || limit < 0 || limit > MAX_DOCUMENT_CACHE_MIB) throw new RangeError('Invalid document cache limit');
    this.maxBytes = limit * MIB;
    // A zero limit also invalidates preparations that started before disabling.
    if (!limit) { this.clear(); return; }
    while (this.entries.size && this.bytes > this.maxBytes) this.evictOldest();
    this.publish();
  }

  get(text: string): Text | undefined {
    const entry = this.entries.get(text);
    if (!entry) return undefined;
    this.entries.delete(text);
    this.entries.set(text, entry);
    return entry.doc;
  }

  put(text: string, doc: Text, generation: number): void {
    if (generation !== this.epoch) return;
    // Budget for UTF-16 source + document strings, line/tree overhead and
    // entry bookkeeping. This is conservative accounting, not a heap limit.
    const bytes = text.length * 4 + doc.lines * 64 + 4096;
    if (bytes > this.maxBytes || this.maxEntries <= 0) return;
    const previous = this.entries.get(text);
    if (previous) { this.bytes -= previous.bytes; this.entries.delete(text); }
    while (this.entries.size && (this.bytes + bytes > this.maxBytes || this.entries.size >= this.maxEntries)) {
      this.evictOldest();
    }
    this.entries.set(text, { doc, bytes });
    this.bytes += bytes;
    this.publish();
  }

  clear(): void {
    this.epoch++;
    this.entries.clear();
    this.bytes = 0;
    this.publish();
  }
}

// Type-only CodeMirror import keeps this lifecycle hook in the small bundle.
export const textDocumentCache = new TextDocumentCache();

import { useEffect, useRef, useState } from 'react';
import { Compartment, EditorState, Text } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, drawSelection, keymap, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';

import { copyTextToClipboard } from '../clipboard';
import { useT } from '../i18n';
import { LoadingPane } from './Spinner';
import { DOCUMENT_SELECTION_EVENT, registerTextDocument } from './textDocument';
import { runTextDocumentTask } from './textDocumentTask';

class LineEnding extends WidgetType {
  label: string;
  constructor(label: string) { super(); this.label = label; }
  eq(other: LineEnding) { return this.label === other.label; }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'code-line-ending';
    span.dataset.eol = this.label;
    span.setAttribute('aria-hidden', 'true');
    return span;
  }
}

function lowerBound(starts: Uint32Array, value: number): number {
  let lo = 0, hi = starts.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (starts[mid] < value) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Decorations only cover rendered ranges, including partial long lines. */
function decorations(starts: Uint32Array, queryLength: number, active: number | null, offset: number, endings: boolean) {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = this.build(view); }
    update(update: ViewUpdate) { if (update.viewportChanged || update.docChanged) this.decorations = this.build(update.view); }
    build(view: EditorView) {
      const ranges = [];
      for (const { from, to } of view.visibleRanges) {
        for (let i = lowerBound(starts, from - queryLength + 1); i < starts.length && starts[i] < to; i++) {
          const start = Math.max(from, starts[i]), end = Math.min(to, starts[i] + queryLength);
          if (end > start) ranges.push(Decoration.mark({ tagName: 'mark', class: i + offset === active ? 'find-current' : '', attributes: { 'data-find-index': String(i + offset) } }).range(start, end));
        }
        if (endings) {
          const text = view.state.doc.sliceString(from, to);
          for (const match of text.matchAll(/\r\n|\r|\n/g)) {
            ranges.push(Decoration.widget({ widget: new LineEnding(match[0] === '\r\n' ? '\\r\\n' : match[0] === '\r' ? '\\r' : '\\n'), side: -1 }).range(from + match.index));
          }
        }
      }
      return Decoration.set(ranges, true);
    }
  }, { decorations: value => value.decorations });
}

export default function LargeTextView({ text, className, query = '', activeIndex = null, offset = 0, showLineEndings = false, wrap = true, onMatchCount }: {
  text: string; className: string; query?: string; activeIndex?: number | null; offset?: number;
  showLineEndings?: boolean; wrap?: boolean; onMatchCount?: (count: number) => void;
}) {
  const t = useT();
  const mount = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const wrapConfig = useRef(new Compartment());
  const marksConfig = useRef(new Compartment());
  const initialWrap = useRef(wrap);
  const [readyText, setReadyText] = useState<string | null>(null);
  const [error, setError] = useState<{ text: string; message: string } | null>(null);
  const [found, setFound] = useState<{ text: string; query: string; starts: Uint32Array } | null>(null);
  const ready = readyText === text;
  const matchesReady = !query || (found?.text === text && found.query === query);

  useEffect(() => { initialWrap.current = wrap; }, [wrap]);

  useEffect(() => {
    const controller = new AbortController();
    let view: EditorView | undefined;
    let unregister: (() => void) | undefined;
    // Let the loading indicator paint before constructing the view.
    const frame = requestAnimationFrame(() => {
      setReadyText(null);
      void runTextDocumentTask({ kind: 'document', text }, controller.signal).then(result => {
        if (controller.signal.aborted || !mount.current || !('lines' in result)) return;
        view = new EditorView({
          parent: mount.current,
          state: EditorState.create({ doc: Text.of(result.lines), extensions: [
            EditorState.readOnly.of(true), EditorState.lineSeparator.of('\n'),
            EditorView.contentAttributes.of({ 'aria-readonly': 'true', 'aria-label': t('detail.body') }),
            EditorView.theme({ '&': { fontSize: 'inherit', height: '100%' }, '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.5', overflow: 'auto' }, '.cm-content': { padding: '8px', caretColor: 'transparent' }, '.cm-line': { padding: '0' }, '&.cm-focused': { outline: 'none' }, '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--accent-dim)' } }),
            keymap.of(defaultKeymap), drawSelection(),
            wrapConfig.current.of(initialWrap.current ? EditorView.lineWrapping : []), marksConfig.current.of([]),
            EditorView.updateListener.of(update => {
              if (update.selectionSet) document.dispatchEvent(new Event(DOCUMENT_SELECTION_EVENT));
            }),
          ] }),
        });
        editor.current = view;
        unregister = registerTextDocument(view.dom, () => {
          const { from, to } = view!.state.selection.main;
          return { text: text.slice(from, to), start: from, end: to };
        });
        // Native and application-menu Copy both use document offsets. The
        // DOM may contain gaps, and must never be the clipboard source.
        view.dom.addEventListener('copy', event => {
          const { from, to } = view!.state.selection.main;
          if (from === to) return;
          event.preventDefault();
          if (event.clipboardData) event.clipboardData.setData('text/plain', text.slice(from, to));
          else copyTextToClipboard(text.slice(from, to));
        }, true);
        view.requestMeasure({ read: () => null, write: () => { if (!controller.signal.aborted) setReadyText(text); } });
      }).catch(cause => {
        if (!controller.signal.aborted) setError({ text, message: String(cause) });
      });
    });
    return () => { controller.abort(); cancelAnimationFrame(frame); unregister?.(); view?.destroy(); editor.current = null; };
  }, [text, t]);

  useEffect(() => {
    if (!query) { onMatchCount?.(0); return; }
    const controller = new AbortController();
    void runTextDocumentTask({ kind: 'search', text, query }, controller.signal).then(result => {
      if (!controller.signal.aborted && 'starts' in result) { setFound({ text, query, starts: result.starts }); onMatchCount?.(result.starts.length); }
    }).catch(cause => { if (!controller.signal.aborted) setError({ text, message: String(cause) }); });
    return () => controller.abort();
  }, [text, query, onMatchCount]);

  useEffect(() => {
    if (!ready || !editor.current) return;
    editor.current.dispatch({ effects: wrapConfig.current.reconfigure(wrap ? EditorView.lineWrapping : []) });
  }, [ready, wrap]);

  useEffect(() => {
    const view = editor.current;
    if (!ready || !view) return;
    const starts = found?.text === text && found.query === query ? found.starts : new Uint32Array();
    const index = activeIndex === null ? -1 : activeIndex - offset;
    const effects = [marksConfig.current.reconfigure(decorations(starts, query.length, activeIndex, offset, showLineEndings))];
    if (index >= 0 && index < starts.length) effects.push(EditorView.scrollIntoView(starts[index], { y: 'center' }));
    view.dispatch({ effects });
  }, [ready, text, query, found, activeIndex, offset, showLineEndings]);

  return <div className={`${className} large-text-view`} aria-busy={!ready || !matchesReady}>
    <div ref={mount} className="large-text-mount" style={{ visibility: ready ? 'visible' : 'hidden' }} />
    {error?.text === text ? <p className="banner error">{t('detail.preview.failed', { message: error.message })}</p>
      : (!ready || !matchesReady) && <div className="large-text-loading"><LoadingPane label={t('detail.preview.loading')} /></div>}
  </div>;
}

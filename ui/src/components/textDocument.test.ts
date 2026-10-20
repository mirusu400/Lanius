import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorSelection, EditorState, Text } from '@codemirror/state';
import { documentSelection, registerTextDocument, selectedText } from './textDocument';
import { prepareTextDocument } from './textDocumentModel';
import { runTextDocumentTask } from './textDocumentTask';

afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });

const SOURCE = 'GET / HTTP/1.1\r\nX: 한글😀e\u0301\r\n\r\n' + 'x'.repeat(1024 * 1024) + '\r끝\nTAIL';

describe('virtual HTTP documents', () => {
  it('retains every character, CRLF, bare CR, emoji and combining marks through a full document selection', () => {
    const prepared = prepareTextDocument({ kind: 'document', text: SOURCE });
    if (!('lines' in prepared)) throw new Error('missing document');
    const state = EditorState.create({ doc: Text.of(prepared.lines), extensions: [EditorState.lineSeparator.of('\n')] });
    const selected = state.update({ selection: EditorSelection.single(0, state.doc.length) }).state;
    expect(selected.sliceDoc(selected.selection.main.from, selected.selection.main.to)).toBe(SOURCE);
    const from = SOURCE.indexOf('한글'), to = from + '한글😀e\u0301\r\n'.length;
    expect(state.sliceDoc(from, to)).toBe('한글😀e\u0301\r\n');
  });

  it('finds literal case-insensitive matches outside the initial viewport and across line endings', () => {
    const search = (query: string) => prepareTextDocument({ kind: 'search', text: SOURCE, query });
    expect(search('tail')).toEqual({ starts: new Uint32Array([SOURCE.indexOf('TAIL')]) });
    expect(search('😀e\u0301\r\n')).toEqual({ starts: new Uint32Array([SOURCE.indexOf('😀')]) });
    expect(prepareTextDocument({ kind: 'search', text: 'a.b A.B aXb', query: 'a.b' })).toEqual({ starts: new Uint32Array([0, 4]) });
  });

  it('reads the full logical selection for the context menu even when most content has no DOM', () => {
    const pane = document.createElement('section'), viewer = document.createElement('div'), visible = document.createElement('span');
    pane.append(viewer); viewer.append(visible); visible.textContent = 'visible fragment'; document.body.append(pane);
    const unregister = registerTextDocument(viewer, () => ({ text: SOURCE, start: 0, end: SOURCE.length }));
    expect(selectedText(pane, visible)).toBe(SOURCE);
    expect(documentSelection(document.createElement('section'), visible)).toBeNull();
    unregister();
    expect(documentSelection(pane, visible)).toBeNull();
  });

  it('terminates a superseded worker instead of allowing stale work to complete', async () => {
    const terminate = vi.fn(), postMessage = vi.fn();
    vi.stubGlobal('Worker', class { terminate = terminate; postMessage = postMessage; });
    const controller = new AbortController();
    const task = runTextDocumentTask({ kind: 'document', text: SOURCE }, controller.signal);
    const rejected = expect(task).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    expect(terminate).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledOnce();
  });
});

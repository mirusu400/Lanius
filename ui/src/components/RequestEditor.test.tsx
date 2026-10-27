/** The editor's views, and the rule they exist to keep.
 *
 * The raw text is the request. Pretty and Hex are ways of reading it.
 * Formatting used to be written into the stored text, so indentation
 * went on the wire and a body checked by length, hash or signature no
 * longer matched what was captured.
 */
import { cleanup, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RequestEditor } from './RequestEditor';
import { renderWithI18n, t } from '../test-utils';

// Newlines are written as LF here because a textarea normalises CRLF to
// LF on the way in, so a CRLF fixture would not be what the component
// actually holds. The engine rebuilds the header lines when sending, so
// this does not change the request.
const RAW =
  'POST /a HTTP/1.1\nHost: x.test\nContent-Type: application/json\n\n{"a":1,"b":2}';

afterEach(cleanup);

function editor(value = RAW) {
  const onChange = vi.fn<(raw: string) => void>();
  renderWithI18n(
    <RequestEditor value={value} onChange={onChange} label="request" />,
  );
  return { onChange };
}

const box = () => screen.getByRole('textbox', { name: 'request' }) as HTMLTextAreaElement;
const tab = (name: string) => screen.getByRole('tab', { name });

function StatefulEditor({ initial = RAW }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return <RequestEditor value={value} onChange={setValue} label="request" />;
}

function ReplayEditor({ initial = RAW }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return <RequestEditor value={value} onChange={setValue} label="request"
    initialView="raw" enableFindReplace />;
}

describe('what gets sent', () => {
  it('keeps display toggles out of the editable request and sent bytes', async () => {
    const { onChange } = editor();
    await userEvent.click(screen.getByRole('button', { name: t('body.showLineEndings') }));
    await userEvent.click(screen.getByRole('button', { name: t('body.wrap') }));
    await userEvent.click(tab(t('detail.view.raw')));
    expect(box().value).toBe(RAW);
    expect(box().wrap).toBe('off');
    expect(document.querySelector('.highlight-editor-overlay')?.textContent).toBe(RAW);
    expect(document.querySelectorAll('.highlight-editor-overlay .code-line-ending')).toHaveLength(4);
    expect(onChange).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: t('body.wrap') }));
    expect(box().wrap).toBe('soft');
    await userEvent.type(box(), 'x');
    expect(onChange).toHaveBeenLastCalledWith(`${RAW}x`);
  });

  it('opens in Pretty while keeping the raw bytes exactly as captured', async () => {
    editor();
    expect(tab(t('detail.view.parsed')).getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('.request-editor-view pre')?.textContent).toContain('"a": 1');
    expect(screen.queryByRole('textbox')).toBeNull();

    await userEvent.click(tab(t('detail.view.raw')));
    expect(box().value).toBe(RAW);
    expect(box().value).toContain('{"a":1,"b":2}');
    expect(box().value).not.toContain('"a": 1');
  });

  it('colours the editable raw request without changing its text', async () => {
    editor();
    await userEvent.click(tab(t('detail.view.raw')));
    expect(document.querySelector('.request-highlight-editor .hljs-keyword')?.textContent).toBe('POST');
    expect([...document.querySelectorAll('.request-highlight-editor .hljs-attr')].map((node) => node.textContent)).toContain('Content-Type');
    expect([...document.querySelectorAll('.request-highlight-editor .hljs-attr')].map((node) => node.textContent)).toContain('"a"');
    expect(box().value).toBe(RAW);
  });

  it('does not rewrite the request when a view is changed', async () => {
    // Looking at something must not alter it.
    const { onChange } = editor();
    await userEvent.click(tab(t('detail.view.parsed')));
    await userEvent.click(tab(t('detail.view.hex')));
    await userEvent.click(tab(t('detail.view.raw')));
    expect(onChange).not.toHaveBeenCalled();
    expect(box().value).toBe(RAW);
  });

  it('keeps the raw bytes after a look at the pretty view', async () => {
    editor();
    await userEvent.click(tab(t('detail.view.parsed')));
    await userEvent.click(tab(t('detail.view.raw')));
    expect(box().value).toBe(RAW);
  });
});

describe('views', () => {
  it('can open directly in the editable Raw view for Replay', () => {
    renderWithI18n(<ReplayEditor />);
    expect(tab(t('detail.view.raw')).getAttribute('aria-selected')).toBe('true');
    expect(box().value).toBe(RAW);
  });

  it('lays the body out in the pretty view', async () => {
    editor();
    await userEvent.click(tab(t('detail.view.parsed')));
    expect(document.querySelector('.request-editor-view pre')?.textContent).toContain('"a": 1');
    expect([...document.querySelectorAll('.request-editor-view .hljs-attr')].map((node) => node.textContent)).toContain('"a"');
  });

  it('leaves the headers alone when laying the body out', async () => {
    // Headers are not JSON, and are often the thing being tested.
    editor();
    await userEvent.click(tab(t('detail.view.parsed')));
    expect(document.querySelector('.request-editor-view pre')?.textContent).toContain('Content-Type: application/json');
  });

  it('shows a hex dump', async () => {
    editor();
    await userEvent.click(tab(t('detail.view.hex')));
    // "POST" in hex.
    expect(screen.getByText(/50 4f 53 54/)).toBeTruthy();
  });

  it('says a view is read only rather than ignoring typing', async () => {
    // Otherwise it is discovered by typing into a box that does nothing.
    editor();
    await userEvent.click(tab(t('detail.view.parsed')));
    expect(screen.getByText(t('editor.viewOnly'))).toBeTruthy();
  });

  it('has no text box outside the raw view', async () => {
    editor();
    await userEvent.click(tab(t('detail.view.hex')));
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('edits go to the raw text unchanged', async () => {
    const { onChange } = editor('GET / HTTP/1.1\n\n');
    await userEvent.click(tab(t('detail.view.raw')));
    await userEvent.type(box(), 'x');
    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.calls.at(-1)?.[0] ?? '';
    expect(last).toContain('GET / HTTP/1.1');
  });
});

describe('find and replace', () => {
  it('finds, navigates, and replaces literal matches in the raw request', async () => {
    const user = userEvent.setup();
    renderWithI18n(<ReplayEditor initial={'GET /old/old HTTP/1.1\nHost: old.test\n\nold'} />);

    const replaceToggle = screen.getByRole('button', { name: t('editor.replaceIn', { pane: 'request' }) });
    expect(replaceToggle.querySelector('svg')).toBeTruthy();
    await user.click(replaceToggle);
    const search = screen.getByRole('searchbox', { name: t('detail.findIn', { pane: 'request' }) });
    await user.type(search, 'old');
    expect(document.querySelector('.detail-find-count')?.textContent).toBe('1/4');
    expect(document.querySelector('.request-highlight-editor mark.find-current')?.textContent).toBe('old');

    await user.click(screen.getByRole('button', { name: t('detail.findNext') }));
    expect(document.querySelector('.detail-find-count')?.textContent).toBe('2/4');

    await user.type(screen.getByRole('textbox', { name: t('editor.replacement') }), 'new');
    await user.click(screen.getByRole('button', { name: t('editor.replaceAll') }));
    expect(box().value).toBe('GET /new/new HTTP/1.1\nHost: new.test\n\nnew');
    expect(document.querySelector('.detail-find-count')?.textContent).toBe('0/0');
  });

  it('opens find with Ctrl+F while the request editor is active', () => {
    renderWithI18n(<ReplayEditor />);
    box().focus();
    fireEvent.keyDown(box(), { key: 'f', ctrlKey: true });
    expect(screen.getByRole('searchbox', { name: t('detail.findIn', { pane: 'request' }) })).toBeTruthy();
  });
});

describe('edit history', () => {
  it('undoes and redoes controlled edits with Windows and Linux shortcuts', async () => {
    renderWithI18n(<StatefulEditor />);
    await userEvent.click(tab(t('detail.view.raw')));
    const input = box();
    input.setSelectionRange(input.value.length, input.value.length);
    await userEvent.type(input, 'x');
    expect(input.value).toBe(`${RAW}x`);

    fireEvent.keyDown(input, { key: 'z', code: 'KeyZ', ctrlKey: true });
    expect(input.value).toBe(RAW);
    fireEvent.keyDown(input, { key: 'y', code: 'KeyY', ctrlKey: true });
    expect(input.value).toBe(`${RAW}x`);
  });

  it('supports the macOS redo shortcut and clears redo after a new edit', async () => {
    renderWithI18n(<StatefulEditor initial="abc" />);
    await userEvent.click(tab(t('detail.view.raw')));
    const input = box();
    input.setSelectionRange(3, 3);
    await userEvent.type(input, 'd');
    fireEvent.keyDown(input, { key: 'z', code: 'KeyZ', metaKey: true });
    expect(input.value).toBe('abc');
    fireEvent.keyDown(input, { key: 'z', code: 'KeyZ', metaKey: true, shiftKey: true });
    expect(input.value).toBe('abcd');

    fireEvent.keyDown(input, { key: 'z', code: 'KeyZ', metaKey: true });
    await userEvent.type(input, 'x');
    fireEvent.keyDown(input, { key: 'y', code: 'KeyY', ctrlKey: true });
    expect(input.value).toBe('abcx');
  });

  it('can undo a formatting action', async () => {
    renderWithI18n(<StatefulEditor />);
    await userEvent.click(tab(t('detail.view.raw')));
    await userEvent.click(screen.getByRole('button', { name: t('body.format') }));
    expect(box().value).toContain('"a": 1');
    fireEvent.keyDown(box(), { key: 'z', code: 'KeyZ', ctrlKey: true });
    expect(box().value).toBe(RAW);
  });
});

describe('reformatting on request', () => {
  it('offers to lay the body out, as an action', async () => {
    // Still useful, but something you ask for rather than something
    // that happens when a request is opened.
    const { onChange } = editor();
    await userEvent.click(tab(t('detail.view.raw')));
    await userEvent.click(screen.getByRole('button', { name: t('body.format') }));
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls[0][0]).toContain('"a": 1');
  });

  it('offers to put it back on one line', async () => {
    const pretty = 'POST /a HTTP/1.1\n\n{\n  "a": 1\n}';
    const { onChange } = editor(pretty);
    await userEvent.click(tab(t('detail.view.raw')));
    await userEvent.click(screen.getByRole('button', { name: t('body.minify') }));
    expect(onChange.mock.calls[0][0]).toContain('{"a":1}');
  });

  it('does not offer to format a body that is not JSON', () => {
    editor('POST /a HTTP/1.1\n\nuser=alice&pw=hunter2');
    expect(screen.queryByRole('button', { name: t('body.format') })).toBeNull();
  });

  it('does not offer to format a request with no body', () => {
    editor('GET / HTTP/1.1\nHost: x\n\n');
    expect(screen.queryByRole('button', { name: t('body.format') })).toBeNull();
  });
});

/** The editor's views, and the rule they exist to keep.
 *
 * The raw text is the request. Pretty and Hex are ways of reading it.
 * Formatting used to be written into the stored text, so indentation
 * went on the wire and a body checked by length, hash or signature no
 * longer matched what was captured.
 */
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

const box = () => screen.getByRole('textbox') as HTMLTextAreaElement;
const tab = (name: string) => screen.getByRole('tab', { name });

describe('what gets sent', () => {
  it('opens on the raw bytes, exactly as captured', () => {
    // The defect this replaces: the body arrived already reformatted, so
    // the request could not be reproduced.
    editor();
    expect(box().value).toBe(RAW);
    expect(box().value).toContain('{"a":1,"b":2}');
    expect(box().value).not.toContain('"a": 1');
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
  it('lays the body out in the pretty view', async () => {
    editor();
    await userEvent.click(tab(t('detail.view.parsed')));
    expect(screen.getByText(/"a": 1/)).toBeTruthy();
  });

  it('leaves the headers alone when laying the body out', async () => {
    // Headers are not JSON, and are often the thing being tested.
    editor();
    await userEvent.click(tab(t('detail.view.parsed')));
    expect(screen.getByText(/Content-Type: application\/json/)).toBeTruthy();
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
    await userEvent.type(box(), 'x');
    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.calls.at(-1)?.[0] ?? '';
    expect(last).toContain('GET / HTTP/1.1');
  });
});

describe('reformatting on request', () => {
  it('offers to lay the body out, as an action', async () => {
    // Still useful, but something you ask for rather than something
    // that happens when a request is opened.
    const { onChange } = editor();
    await userEvent.click(screen.getByRole('button', { name: t('body.format') }));
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls[0][0]).toContain('"a": 1');
  });

  it('offers to put it back on one line', async () => {
    const pretty = 'POST /a HTTP/1.1\n\n{\n  "a": 1\n}';
    const { onChange } = editor(pretty);
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

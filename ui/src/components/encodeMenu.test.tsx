import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithI18n, t } from '../test-utils';
import { useEditorMenu } from './useEditorMenu';

import {
  base64Decode,
  base64Encode,
  base64UrlEncode,
  encodeMenuItems,
  hexDecode,
  hexEncode,
  htmlDecode,
  htmlEncode,
  replaceRange,
  urlDecode,
  urlEncodeAll,
  urlEncodeKey,
} from './encodeMenu';

describe('encodeMenu transforms', () => {
  it('URL-encodes key characters and leaves unreserved ones', () => {
    expect(urlEncodeKey("a b&c=d/é'<x>")).toBe('a%20b%26c%3Dd%2F%C3%A9%27%3Cx%3E');
    expect(urlEncodeKey('A-z_0.9~')).toBe('A-z_0.9~');
  });

  it('URL-encodes every byte', () => {
    expect(urlEncodeAll('ab/')).toBe('%61%62%2F');
    expect(urlEncodeAll('é')).toBe('%C3%A9');
  });

  it('URL-decodes, treating + as space and keeping stray percents', () => {
    expect(urlDecode('a%20b+c%C3%A9')).toBe('a b cé');
    expect(urlDecode('100%')).toBe('100%');
    expect(urlDecode('%zz%41')).toBe('%zzA');
    expect(urlDecode('%FF')).toBe('ÿ');
  });

  it('round-trips Base64, including URL-safe and unpadded input', () => {
    expect(base64Encode('héllo')).toBe('aMOpbGxv');
    expect(base64Decode('aMOpbGxv')).toBe('héllo');
    expect(base64UrlEncode('??>')).toBe('Pz8-');
    expect(base64Decode('Pz8-')).toBe('??>');
    expect(base64Decode('YQ')).toBe('a');
    expect(base64Decode('not base64!')).toBeNull();
    expect(base64Decode('a')).toBeNull();
  });

  it('encodes and decodes HTML without interpreting markup', () => {
    expect(htmlEncode(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#x27;&amp;&#x27;&lt;/a&gt;');
    expect(htmlDecode('&lt;b&gt;&amp;&#65;<i>x</i>')).toBe('<b>&A<i>x</i>');
  });

  it('encodes and decodes hex in common spellings', () => {
    expect(hexEncode('AB')).toBe('4142');
    expect(hexDecode('41 42')).toBe('AB');
    expect(hexDecode('\\x41\\x42')).toBe('AB');
    expect(hexDecode('0x41')).toBe('A');
    expect(hexDecode('414')).toBeNull();
    expect(hexDecode('zz')).toBeNull();
  });

  it('replaces a range and reports where the new value sits', () => {
    expect(replaceRange('a=xy&b', 2, 4, 'Zm9v')).toEqual({ text: 'a=Zm9v&b', start: 2, end: 6 });
  });
});

describe('encodeMenuItems', () => {
  const t = (key: string) => key;

  it('disables decoders that cannot read the selection', () => {
    const [encode, decode] = encodeMenuItems(t, 'not base64!', () => undefined, true);
    expect(encode.items?.every((item) => !item.disabled)).toBe(true);
    const base64 = decode.items?.find((item) => item.label === 'decode.base64');
    expect(base64?.disabled).toBe(true);
  });

  it('applies the transformed value', () => {
    let applied = '';
    const [encode] = encodeMenuItems(t, 'a b', (value) => { applied = value; }, true);
    encode.items?.find((item) => item.label === 'encode.urlKey')?.onSelect?.();
    expect(applied).toBe('a%20b');
  });

  it('disables both submenus without an editable selection', () => {
    const items = encodeMenuItems(t, 'abc', () => undefined, false);
    expect(items.every((item) => item.disabled)).toBe(true);
  });
});

describe('useEditorMenu encoding', () => {
  function Harness() {
    const [value, setValue] = useState('q=a b&x=1');
    const menu = useEditorMenu();
    return (
      <>
        <textarea
          aria-label="editor"
          ref={menu.ref}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onContextMenu={menu.open}
        />
        {menu.element}
      </>
    );
  }

  it('replaces the selection with its encoded form', async () => {
    renderWithI18n(<Harness />);
    const editor = screen.getByLabelText('editor') as HTMLTextAreaElement;
    editor.setSelectionRange(2, 5);
    fireEvent.contextMenu(editor);
    await userEvent.hover(screen.getByRole('menuitem', { name: new RegExp(t('encode.menu')) }));
    await userEvent.click(screen.getByRole('menuitem', { name: t('encode.urlKey') }));
    expect(editor.value).toBe('q=a%20b&x=1');
  });
});

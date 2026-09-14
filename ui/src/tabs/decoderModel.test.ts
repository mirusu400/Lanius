import { beforeEach, describe, expect, it } from 'vitest';

import {
  decoderTabTitle,
  emptyDecoderTab,
  looksBinary,
  resetDecoderIds,
  toHexDump,
  type DecoderTabState,
} from './decoderModel';

beforeEach(() => resetDecoderIds());

describe('decoder tabs', () => {
  it('gives each tab a distinct id', () => {
    expect(emptyDecoderTab().id).not.toBe(emptyDecoderTab().id);
  });

  it('starts empty', () => {
    const tab = emptyDecoderTab();
    expect(tab.input).toBe('');
    expect(tab.steps).toEqual([]);
  });
});

describe('decoderTabTitle', () => {
  const base: DecoderTabState = {
    id: 'd1',
    title: '',
    input: '',
    steps: [],
    renamed: false,
  };

  it('falls back when there is nothing to show', () => {
    expect(decoderTabTitle(base, 'Untitled')).toBe('Untitled');
  });

  it('follows the input while the tab is unnamed', () => {
    expect(decoderTabTitle({ ...base, input: 'eyJhbGc' }, 'x')).toBe('eyJhbGc');
  });

  it('uses only the first line', () => {
    expect(decoderTabTitle({ ...base, input: 'first\nsecond' }, 'x')).toBe('first');
  });

  it('truncates a long payload so the strip stays readable', () => {
    const title = decoderTabTitle({ ...base, input: 'a'.repeat(50) }, 'x');
    expect(title).toBe(`${'a'.repeat(18)}...`);
  });

  it('keeps an explicit name even when the input changes', () => {
    expect(
      decoderTabTitle({ ...base, title: 'session', renamed: true, input: 'zzz' }, 'x'),
    ).toBe('session');
  });

  it('ignores a renamed but blank title', () => {
    expect(decoderTabTitle({ ...base, title: '  ', renamed: true }, 'Untitled')).toBe(
      'Untitled',
    );
  });
});

describe('looksBinary', () => {
  it('treats ordinary text as text', () => {
    expect(looksBinary('hello world')).toBe(false);
    expect(looksBinary('{"a": 1}\n')).toBe(false);
  });

  it('does not count tabs and newlines against it', () => {
    expect(looksBinary('a\tb\nc\r\n')).toBe(false);
  });

  it('spots control bytes', () => {
    expect(looksBinary('\x00\x01\x02\x03binary')).toBe(true);
  });

  it('tolerates the odd stray byte in mostly-text output', () => {
    expect(looksBinary(`${'text'.repeat(30)}\x00`)).toBe(false);
  });

  it('says nothing about an empty value', () => {
    expect(looksBinary('')).toBe(false);
  });
});

describe('toHexDump', () => {
  it('lays out offset, hex and ascii', () => {
    expect(toHexDump('AB')).toBe('00000000  41 42                                            AB');
  });

  it('wraps at the given width', () => {
    const lines = toHexDump('0123456789abcdef0', 16).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1].startsWith('00000010')).toBe(true);
  });

  it('shows unprintable bytes as dots', () => {
    expect(toHexDump('\x00\x01')).toContain('..');
  });

  it('encodes multi-byte characters as their utf-8 bytes', () => {
    // 'é' is two bytes, so a naive charCode dump would be wrong.
    expect(toHexDump('é')).toContain('c3 a9');
  });

  it('returns nothing for an empty value', () => {
    expect(toHexDump('')).toBe('');
  });
});

import { describe, expect, it } from 'vitest';
import {
  generatePayloads, previewPayloads, MAKER_PREVIEW_ROWS, MAX_MAKER_BYTES,
  type PayloadMakerConfig, type PayloadSource, type PayloadStep,
} from './payloadMakerModel';

const numbers = (patch = {}): PayloadSource => ({ kind: 'numbers', start: '0', end: '2', step: '1', padding: '0', ...patch });
const characters = (patch = {}): PayloadSource => ({ kind: 'characters', alphabet: 'ab', minLength: '1', maxLength: '2', ...patch });
const dates = (patch = {}): PayloadSource => ({ kind: 'dates', start: '2024-02-28', end: '2024-03-01', step: '1', format: 'YYYY-MM-DD', ...patch });
const step = (kind: PayloadStep['kind'], value = '', replacement = '', omitPadding = false): PayloadStep => ({ kind, value, replacement, omitPadding });
const config = (source: PayloadSource, steps: PayloadStep[] = []): PayloadMakerConfig => ({ source, steps });
const existing = (text: string, steps: PayloadStep[] = []) => config({ kind: 'existing', text }, steps);

describe('Payload Maker sources', () => {
  it('includes the numeric end and pads digits without truncating', () => {
    expect(generatePayloads(config(numbers()))).toBe('0\n1\n2');
    expect(generatePayloads(config(numbers({ start: '8', end: '12', step: '2', padding: '2' })))).toBe('08\n10\n12');
  });

  it('counts down and handles negative values and non-aligned ends', () => {
    expect(generatePayloads(config(numbers({ start: '3', end: '-2', step: '2', padding: '3' })))).toBe('003\n001\n-001');
  });

  it('keeps integers beyond Number precision exact', () => {
    expect(generatePayloads(config(numbers({ start: '9007199254740992', end: '9007199254740994' })))).toBe('9007199254740992\n9007199254740993\n9007199254740994');
  });

  it.each(['0', '-1', '1.5', '', '1e3'])('rejects invalid steps: %s', (value) => {
    expect(() => generatePayloads(config(numbers({ step: value })))).toThrow();
  });

  it.each(['1.1', '', 'Infinity', '1e10', '9'.repeat(65)])('rejects invalid numbers: %s', (start) => {
    expect(() => previewPayloads(config(numbers({ start })))).toThrow('payloadMaker.invalidInteger');
  });

  it('generates shorter character strings first, using alphabet order', () => {
    expect(generatePayloads(config(characters()))).toBe('a\nb\naa\nab\nba\nbb');
    expect(generatePayloads(config(characters({ alphabet: 'ba', minLength: '2' })))).toBe('bb\nba\nab\naa');
  });

  it('deduplicates alphabet symbols and supports Unicode code points', () => {
    expect(generatePayloads(config(characters({ alphabet: '😀a😀', maxLength: '1' })))).toBe('😀\na');
  });

  it.each([
    { alphabet: '' }, { alphabet: 'a\nb' }, { alphabet: 'a\rb' },
    { minLength: '0' }, { minLength: '3', maxLength: '2' }, { maxLength: '33' },
  ])('rejects invalid character settings: %o', (patch) => {
    expect(() => previewPayloads(config(characters(patch)))).toThrow();
  });

  it('matches Fuzzer parsing of the current set', () => {
    expect(generatePayloads(existing(' a \r\n\n b\nc\n'))).toBe('a\nb\nc');
    expect(() => generatePayloads(existing(' \n\t'))).toThrow('payloadMaker.emptySource');
  });
});

describe('Payload Maker processing', () => {
  it('processes in order and preserves UTF-8 in Base64', () => {
    expect(generatePayloads(existing('한글', [step('base64')]))).toBe('7ZWc6riA');
    expect(generatePayloads(existing('x', [step('prefix', 'a '), step('base64'), step('url')]))).toBe('YSB4');
    expect(generatePayloads(existing('x', [step('base64'), step('prefix', 'a '), step('url')]))).toBe('a%20eA%3D%3D');
  });

  it('distinguishes URL component encoding from form encoding', () => {
    expect(generatePayloads(existing("a +/!*'()", [step('url')]))).toBe('a%20%2B%2F%21%2A%27%28%29');
    expect(generatePayloads(existing('a +/', [step('form')]))).toBe('a+%2B%2F');
  });

  it('supports URL-safe Base64 and optional padding', () => {
    expect(generatePayloads(existing('ÿ?', [step('base64')]))).toBe('w78/');
    expect(generatePayloads(existing('ÿ?', [step('base64url')]))).toBe('w78_');
    expect(generatePayloads(existing('a', [step('base64url', '', '', true)]))).toBe('YQ');
    expect(generatePayloads(existing('a', [step('base64url')]))).toBe('YQ==');
  });

  it('supports suffixes, case conversion and literal replacement including $', () => {
    expect(generatePayloads(existing('abcabc', [step('uppercase'), step('replace', 'AB', '$&'), step('suffix', '!')]))).toBe('$&C$&C!');
    expect(generatePayloads(existing('AB', [step('lowercase')]))).toBe('ab');
    expect(() => generatePayloads(existing('x', [step('replace')]))).toThrow('payloadMaker.emptySearch');
  });

  it('deduplicates at the selected step, retaining first occurrence order', () => {
    expect(generatePayloads(existing('b\na\nb\nA', [step('uppercase'), step('deduplicate')]))).toBe('B\nA');
    expect(generatePayloads(existing('a\nA', [step('deduplicate'), step('uppercase')]))).toBe('A\nA');
  });

  it('refuses outputs that the Fuzzer would change but allows encoding them', () => {
    expect(() => generatePayloads(existing('x', [step('prefix', ' ')]))).toThrow('payloadMaker.invalidOutput');
    expect(() => generatePayloads(existing('x', [step('suffix', '\n')]))).toThrow('payloadMaker.invalidOutput');
    expect(() => generatePayloads(existing('x', [step('replace', 'x', '')]))).toThrow('payloadMaker.invalidOutput');
    expect(generatePayloads(existing('x', [step('prefix', ' '), step('url')]))).toBe('%20x');
  });
});

describe('Payload Maker dates', () => {
  it('includes leap days and the end date', () => {
    expect(generatePayloads(config(dates()))).toBe('2024-02-28\n2024-02-29\n2024-03-01');
    expect(generatePayloads(config(dates({ start: '2000-02-28', end: '2000-03-01' })))).toBe('2000-02-28\n2000-02-29\n2000-03-01');
  });

  it.each([
    ['YYYY-MM-DD', '2026-10-20'], ['YYYYMMDD', '20261020'], ['YYMMDD', '261020'],
    ['DD/MM/YYYY', '20/10/2026'], ['MM/DD/YYYY', '10/20/2026'], ['MMDD', '1020'],
  ])('supports %s formatting', (format, expected) => {
    expect(generatePayloads(config(dates({ start: '2026-10-20', end: '2026-10-20', format })))).toBe(expected);
  });

  it('counts down across years with a day interval', () => {
    const input = config(dates({ start: '2026-01-03', end: '2025-12-29', step: '2' }));
    expect(generatePayloads(input)).toBe('2026-01-03\n2026-01-01\n2025-12-30');
    expect(previewPayloads(input).count).toBe(3n);
  });

  it('keeps calendar days intact across daylight saving changes', () => {
    expect(generatePayloads(config(dates({ start: '2026-03-07', end: '2026-03-10' })))).toBe('2026-03-07\n2026-03-08\n2026-03-09\n2026-03-10');
    expect(generatePayloads(config(dates({ start: '2026-10-31', end: '2026-11-02' })))).toBe('2026-10-31\n2026-11-01\n2026-11-02');
  });

  it('handles years below 100 and the upper date bound', () => {
    expect(generatePayloads(config(dates({ start: '0099-12-31', end: '0100-01-01' })))).toBe('0099-12-31\n0100-01-01');
    expect(generatePayloads(config(dates({ start: '0001-01-01', end: '0001-01-01' })))).toBe('0001-01-01');
    expect(generatePayloads(config(dates({ start: '9999-12-30', end: '9999-12-31' })))).toBe('9999-12-30\n9999-12-31');
  });

  it.each(['2026-02-29', '1900-02-29', '2024-02-30', '2026-13-01', '2026-01-00', '0000-01-01', '10000-01-01', '', '2026-1-1', '2026-01-01T00:00:00Z'])('rejects invalid dates: %s', (start) => {
    expect(() => generatePayloads(config(dates({ start })))).toThrow('payloadMaker.invalidDate');
  });

  it('rejects invalid end dates, intervals, and output formats', () => {
    expect(() => previewPayloads(config(dates({ end: '2026-04-31' })))).toThrow('payloadMaker.invalidDate');
    for (const step of ['0', '-1', '0.5']) expect(() => generatePayloads(config(dates({ step })))).toThrow();
    expect(() => generatePayloads(config(dates({ format: 'YYYY-XX-DD' })))).toThrow('payloadMaker.invalidDateFormat');
    expect(generatePayloads(config(dates({ step: '9'.repeat(64) })))).toBe('2024-02-28');
  });

  it('uses the shared processing pipeline and append behavior', () => {
    const input = config(dates({ start: '2026-10-20', end: '2026-10-20', format: 'DD/MM/YYYY' }), [step('url')]);
    expect(previewPayloads(input).rows).toEqual([{ original: '20/10/2026', result: '20%2F10%2F2026' }]);
    expect(generatePayloads(input, 'old')).toBe('old\n20%2F10%2F2026');
  });

  it('previews and limits a large date range without building it', () => {
    const input = config(dates({ start: '0001-01-01', end: '9999-12-31' }));
    const preview = previewPayloads(input);
    expect(preview.rows).toHaveLength(MAKER_PREVIEW_ROWS);
    expect(preview.rows[0].original).toBe('0001-01-01');
    expect(preview.count).toBe(3_652_059n);
    expect(preview.overLimit).toBe(true);
    expect(() => generatePayloads(input)).toThrow('payloadMaker.limitCount');
  });
});

describe('Payload Maker preview, append and limits', () => {
  it('bounds the preview without constructing an enormous character list', () => {
    const preview = previewPayloads(config(characters({ alphabet: 'abcdefghijklmnopqrstuvwxyz', maxLength: '32' })));
    expect(preview.rows).toHaveLength(MAKER_PREVIEW_ROWS);
    expect(preview.rows[26].original).toBe('aa');
    expect(preview.count).toBeGreaterThan(100_000n);
    expect(preview.overLimit).toBe(true);
  });

  it('shows deduplicated preview rows and matches full processing', () => {
    const input = existing('a\nA\nb', [step('uppercase'), step('deduplicate')]);
    expect(previewPayloads(input).rows.map((row) => row.result)).toEqual(['A', null, 'B']);
    expect(generatePayloads(input)).toBe('A\nB');
  });

  it('preserves existing text when appending, without processing it', () => {
    expect(generatePayloads(config(numbers(), [step('prefix', 'new-')]), ' old \r\n\n')).toBe(' old \r\n\nnew-0\nnew-1\nnew-2');
    expect(generatePayloads(config(numbers({ end: '0' })), 'old')).toBe('old\n0');
    expect(generatePayloads(config(numbers({ end: '0' })), '')).toBe('0');
  });

  it('enforces the count limit including append and accepts the boundary', () => {
    expect(generatePayloads(config(numbers({ end: '99999' })))).toHaveLength(588889);
    expect(() => generatePayloads(config(numbers({ end: '100000' })))).toThrow('payloadMaker.limitCount');
    expect(() => generatePayloads(config(numbers({ end: '0' })), 'x\n'.repeat(100_000))).toThrow('payloadMaker.limitCount');
    expect(() => generatePayloads(config(characters({ alphabet: 'abcdefghijklmnopqrstuvwxyz', maxLength: '32' })))).toThrow('payloadMaker.limitCount');
  });

  it('allows deduplication to make an appended list fit', () => {
    expect(generatePayloads(existing('x\nx', [step('deduplicate')]), 'a\n'.repeat(99_999)).split('\n').filter(Boolean)).toHaveLength(100_000);
  });

  it('bounds UTF-8 output bytes, existing text, and intermediate expansion', () => {
    expect(() => generatePayloads(config(numbers({ end: '700' }), [step('prefix', '한'.repeat(4096))]))).toThrow('payloadMaker.limitBytes');
    expect(() => generatePayloads(config(numbers({ end: '0' })), 'a'.repeat(MAX_MAKER_BYTES + 1))).toThrow('payloadMaker.limitBytes');
    expect(() => generatePayloads(existing('a'.repeat(100), [step('replace', 'a', 'x'.repeat(4096))]))).toThrow('payloadMaker.limitValue');
    expect(() => generatePayloads(existing('x', Array.from({ length: 21 }, () => step('uppercase'))))).toThrow('payloadMaker.limitSteps');
  });
});

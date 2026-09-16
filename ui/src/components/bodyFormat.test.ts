/** Reformatting a body: what it does, and what it must never touch. */
import { describe, expect, it } from 'vitest';

import {
  canReformat,
  formatBody,
  isFormattable,
  minify,
  prettify,
} from './bodyFormat';

describe('prettify', () => {
  it('lays a captured body out over several lines', () => {
    // How they arrive: one line, unreadable.
    const wire = '{"a":1,"b":{"c":[1,2]}}';
    const out = prettify(wire);
    expect(out.split('\n').length).toBeGreaterThan(1);
    expect(JSON.parse(out)).toEqual(JSON.parse(wire));
  });

  it('keeps the meaning exactly', () => {
    const wire = '{"z":1,"a":{"nested":true},"list":[1,"two",null]}';
    expect(JSON.parse(prettify(wire))).toEqual(JSON.parse(wire));
  });

  it('leaves a body that is not JSON alone', () => {
    // Half-formatting a form post would corrupt what is being looked at.
    const form = 'user=alice&password=hunter2';
    expect(prettify(form)).toBe(form);
  });

  it('leaves broken JSON exactly as it is', () => {
    // A body with a mistake in it is the one you most need to see
    // verbatim, and it cannot be re-serialised anyway.
    const broken = '{"a":1,,}';
    expect(prettify(broken)).toBe(broken);
  });

  it('leaves an empty body alone', () => {
    expect(prettify('')).toBe('');
  });

  it('leaves HTML alone', () => {
    const html = '<!doctype html><p>hi</p>';
    expect(prettify(html)).toBe(html);
  });

  it('does not touch a bare number or string', () => {
    // Valid JSON, but there is nothing to lay out and reformatting would
    // only strip the whitespace around it.
    expect(prettify('42')).toBe('42');
    expect(prettify('"hello"')).toBe('"hello"');
  });

  it('preserves Korean text', () => {
    const body = '{"name":"한글"}';
    expect(prettify(body)).toContain('한글');
  });

  it('handles a deeply nested body', () => {
    const deep = JSON.stringify({ a: { b: { c: { d: { e: [1, 2, 3] } } } } });
    expect(JSON.parse(prettify(deep))).toEqual(JSON.parse(deep));
  });
});

describe('minify', () => {
  it('puts a laid-out body back on one line', () => {
    const pretty = '{\n  "a": 1\n}';
    expect(minify(pretty)).toBe('{"a":1}');
  });

  it('leaves a non-JSON body alone', () => {
    expect(minify('a=1&b=2')).toBe('a=1&b=2');
  });

  it('round-trips with prettify', () => {
    const wire = '{"a":1,"b":[1,2,3]}';
    expect(minify(prettify(wire))).toBe(wire);
  });
});

describe('isFormattable', () => {
  it('accepts an object and an array', () => {
    expect(isFormattable('{"a":1}')).toBe(true);
    expect(isFormattable('[1,2]')).toBe(true);
  });

  it('judges by parsing, not by looks', () => {
    // Plenty of APIs send JSON as text/plain, and plenty of things
    // labelled JSON are not.
    expect(isFormattable('{not json}')).toBe(false);
  });

  it('tolerates surrounding whitespace', () => {
    expect(isFormattable('  {"a":1}\n')).toBe(true);
  });

  it('rejects an empty body', () => {
    expect(isFormattable('')).toBe(false);
  });
});

describe('canReformat', () => {
  it('is true for a body that is all on one line', () => {
    expect(canReformat('{"a":1,"b":2}')).toBe(true);
  });

  it('is false when there is nothing to gain', () => {
    // A control that does nothing is worse than no control.
    expect(canReformat('{}')).toBe(false);
    expect(canReformat('not json')).toBe(false);
  });

  it('is false for a body that is already laid out', () => {
    expect(canReformat('{\n  "a": 1\n}')).toBe(false);
  });
});

describe('formatBody', () => {
  it('lays out for the pretty view', () => {
    expect(formatBody('{"a":1}', 'pretty')).toContain('\n');
  });

  it('gives back the exact bytes for the raw view', () => {
    // The point of the raw view: what actually went over the wire,
    // including whitespace someone may care about.
    const wire = '{"a":1,   "b":2}';
    expect(formatBody(wire, 'raw')).toBe(wire);
  });
});

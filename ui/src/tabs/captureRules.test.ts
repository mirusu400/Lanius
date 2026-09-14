import { describe, expect, it } from 'vitest';

import { ruleIsValid, rulesToSpec, specToRules } from './captureRules';

const rule = (value: string, action: 'include' | 'exclude' = 'include') => ({
  value,
  action,
  enabled: true,
});

describe('rulesToSpec', () => {
  it('joins rules the way the redirector expects', () => {
    expect(rulesToSpec([rule('chrome'), rule('Slack', 'exclude')])).toBe(
      'chrome,!Slack',
    );
  });

  it('carries a path through unchanged', () => {
    // Matching is on substrings of the executable path, so a directory
    // captures everything installed under it.
    expect(rulesToSpec([rule('/Applications/')])).toBe('/Applications/');
  });

  it('leaves a disabled rule out without losing it', () => {
    const rules = [rule('chrome'), { ...rule('firefox'), enabled: false }];
    expect(rulesToSpec(rules)).toBe('chrome');
    expect(rules).toHaveLength(2);
  });

  it('skips blank rules, which is what a half-typed row is', () => {
    expect(rulesToSpec([rule('  '), rule('chrome')])).toBe('chrome');
  });

  it('produces an empty spec for an empty list', () => {
    expect(rulesToSpec([])).toBe('');
  });

  it('trims, so a stray space does not become part of the match', () => {
    expect(rulesToSpec([rule('  chrome  ')])).toBe('chrome');
  });
});

describe('specToRules', () => {
  it('reads a spec back', () => {
    const rules = specToRules('chrome,!Slack,/Applications/');
    expect(rules.map((r) => r.value)).toEqual(['chrome', 'Slack', '/Applications/']);
    expect(rules.map((r) => r.action)).toEqual(['include', 'exclude', 'include']);
  });

  it('handles untidy spacing', () => {
    expect(specToRules(' chrome , ! Slack ').map((r) => r.value)).toEqual([
      'chrome',
      'Slack',
    ]);
  });

  it('treats no spec as no rules', () => {
    expect(specToRules(null)).toEqual([]);
    expect(specToRules('')).toEqual([]);
  });

  it('round-trips', () => {
    const original = [rule('chrome'), rule('Slack', 'exclude')];
    expect(specToRules(rulesToSpec(original))).toEqual(original);
  });
});

describe('ruleIsValid', () => {
  it('rejects a comma, which would silently split the rule in two', () => {
    expect(ruleIsValid(rule('chrome,firefox'))).toBe(false);
  });

  it('rejects an empty rule', () => {
    expect(ruleIsValid(rule('   '))).toBe(false);
  });

  it('accepts a name and a path', () => {
    expect(ruleIsValid(rule('chrome'))).toBe(true);
    expect(ruleIsValid(rule('/Applications/Slack.app'))).toBe(true);
  });
});

describe('parity with the engine', () => {
  /** The engine has the same logic in capture_rules.py, because it also
   *  writes and reads the spec. These are the cases both were run against;
   *  if this file changes, engine/tests/test_capture_rules.py should say
   *  the same. */
  const shared: [ReturnType<typeof rule>[], string][] = [
    [[rule('chrome'), rule('Slack', 'exclude')], 'chrome,!Slack'],
    [[rule('/Applications/')], '/Applications/'],
    [[{ ...rule('a'), enabled: false }, rule('b')], 'b'],
    [[rule('  x  ')], 'x'],
    [[], ''],
  ];

  it.each(shared)('matches the engine for %j', (rules, expected) => {
    expect(rulesToSpec(rules)).toBe(expected);
  });
});

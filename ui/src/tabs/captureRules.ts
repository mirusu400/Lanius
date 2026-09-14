/** Capture rules on the UI side.
 *
 * The engine has the same logic in capture_rules.py, because the spec is
 * also written and read there. Keeping a copy here lets the list be
 * edited without a round trip per keystroke; the tests pin that both
 * produce the same string.
 */

export interface CaptureRule {
  value: string;
  action: 'include' | 'exclude';
  enabled: boolean;
}

/** The rule list as the redirector spells it. */
export function rulesToSpec(rules: CaptureRule[]): string {
  return rules
    .filter((rule) => rule.enabled && rule.value.trim())
    .map((rule) => {
      const value = rule.value.trim();
      return rule.action === 'exclude' ? `!${value}` : value;
    })
    .join(',');
}

/** Read a spec back into rules, so one set by hand still edits. */
export function specToRules(spec: string | null | undefined): CaptureRule[] {
  if (!spec) return [];
  return spec
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const exclude = part.startsWith('!');
      return {
        value: exclude ? part.slice(1).trim() : part,
        action: exclude ? ('exclude' as const) : ('include' as const),
        enabled: true,
      };
    });
}

/** A rule containing a comma would silently become two. */
export function ruleIsValid(rule: CaptureRule): boolean {
  const value = rule.value.trim();
  return value.length > 0 && !value.includes(',');
}

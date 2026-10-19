import sharedCss from '../sharedUi.css?raw';

// Only public appearance roles cross the iframe boundary, never arbitrary host styles.
const TOKENS = [
  'bg', 'bg-alt', 'bg-row', 'bg-sunken', 'bg-hover', 'border', 'border-soft',
  'fg', 'muted', 'fg-disabled', 'accent', 'accent-dim', 'on-accent',
  'accent-wash', 'accent-wash-strong', 'accent2', 'accent2-wash',
  'ok', 'ok-bright', 'ok-soft', 'ok-strong', 'ok-border', 'ok-wash',
  'warn', 'warn-dim', 'danger', 'danger-dim', 'danger-soft', 'danger-bright',
  'danger-muted', 'danger-deep', 'danger-bg', 'danger-border', 'danger-wash',
  'info', 'info-soft', 'info-wash', 'chart-2xx', 'chart-3xx', 'shadow',
  'font-ui', 'font-mono', 'font-size-ui', 'font-size-mono',
  'syntax-keyword', 'syntax-name', 'syntax-attribute', 'syntax-string',
  'syntax-number', 'syntax-comment', 'syntax-meta',
] as const;

export interface PluginTheme {
  version: 1;
  theme: string;
  colorScheme: string;
  variables: Record<string, string>;
  css: string;
}

export function readPluginTheme(): PluginTheme {
  const root = document.documentElement;
  const computed = getComputedStyle(root);
  return {
    version: 1,
    theme: root.dataset.theme ?? 'dark',
    colorScheme: computed.colorScheme,
    variables: Object.fromEntries(TOKENS.map((token) => {
      const name = `--${token}`;
      return [name, computed.getPropertyValue(name).trim()];
    })),
    css: sharedCss,
  };
}

/** Observe both palette selection and font overrides, including system-theme changes. */
export function watchPluginTheme(onChange: (theme: PluginTheme) => void): () => void {
  let previous = JSON.stringify(readPluginTheme());
  const observer = new MutationObserver(() => {
    const theme = readPluginTheme();
    const serialized = JSON.stringify(theme);
    if (serialized !== previous) {
      previous = serialized;
      onChange(theme);
    }
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
  return () => observer.disconnect();
}

/** Theme and typography settings.
 *
 * These write to the document rather than to component state, so the
 * tests assert on what the stylesheet will actually read.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppearanceSection } from './settings/AppearanceSection';
import { renderWithI18n as render, t } from '../test-utils';
import {
  DEFAULTS,
  MONO_SIZE_RANGE,
  apply,
  load,
  normalise,
  resolveTheme,
} from '../appearance';

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers({ 'Content-Type': 'application/json' }),
  } as unknown as Response;
}

let systemDark = true;

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('style');
  systemDark = true;

  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('dark') ? systemDark : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    onchange: null,
  }));

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/browser')) {
        return jsonResponse({
          available: false,
          name: null,
          profile: '/tmp/p',
          ca_trusted: false,
        });
      }
      if (url.includes('/api/mcp')) {
        return jsonResponse({
          available: false,
          enabled: false,
          url: '',
          host: '',
          port: 0,
          tools: [],
        });
      }
      if (url.includes('/api/listener')) {
        return jsonResponse({
          host: '127.0.0.1',
          port: 8080,
          running: true,
          error: null,
          exposed: false,
          addresses: [{ host: '127.0.0.1', label: 'This machine only' }],
        });
      }
      if (url.includes('/api/ca')) return jsonResponse({ available: false });
      if (url.includes('/api/tls')) {
        return jsonResponse({
          profile: 'default',
          custom_ciphers: null,
          ciphers: null,
          available: [{ id: 'default', label: 'mitmproxy default' }],
        });
      }
      if (url.includes('/api/capture/local')) {
        return jsonResponse({ supported: false, approved: false, detail: '' });
      }
      if (url.includes('/api/status')) {
        return jsonResponse({
          version: '0.1.0',
          proxy: { running: true, host: '127.0.0.1', port: 8080, error: null },
          flows: 0,
          subscribers: 0,
          db_path: '/tmp/x.sqlite',
          intercept: {
            enabled: false,
            intercept_requests: true,
            intercept_responses: false,
            host_filter: null,
          },
          paused: 0,
          modes: [],
          local_capture: { supported: false, approved: false, detail: '', spec: null },
        });
      }
      return jsonResponse({});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const root = () => document.documentElement;
const section = () => {
  const node = screen.getByText(t('appearance.section')).closest('section');
  if (!node) throw new Error('appearance section not found');
  return within(node);
};

describe('appearance settings', () => {
  it('switches to the light theme', async () => {
    const user = userEvent.setup();
    render(<AppearanceSection />);
    await user.selectOptions(
      section().getByLabelText(t('appearance.theme')),
      'light',
    );
    // The stylesheet selects on this attribute.
    expect(root().dataset.theme).toBe('light');
  });

  it('follows the system when asked to', () => {
    systemDark = false;
    expect(resolveTheme('system')).toBe('light');
    systemDark = true;
    expect(resolveTheme('system')).toBe('dark');
    // An explicit choice ignores the system.
    expect(resolveTheme('light')).toBe('light');
  });

  it('changes the editor font size', async () => {
    render(<AppearanceSection />);
    const slider = section().getByLabelText(t('appearance.monoSize'));

    // Assigning .value directly is invisible to React on a controlled
    // input, so go through the native setter the way the browser does.
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!;
    setter.call(slider, '18');
    slider.dispatchEvent(new Event('change', { bubbles: true }));

    await waitFor(() =>
      expect(root().style.getPropertyValue('--font-size-mono')).toBe('18px'),
    );
  });

  it('changes the editor font family', async () => {
    const user = userEvent.setup();
    render(<AppearanceSection />);
    await user.selectOptions(
      section().getByLabelText(t('appearance.monoFont')),
      'menlo',
    );
    expect(root().style.getPropertyValue('--font-mono')).toContain('Menlo');
  });

  it('remembers the choice for next launch', async () => {
    const user = userEvent.setup();
    render(<AppearanceSection />);
    await user.selectOptions(
      section().getByLabelText(t('appearance.theme')),
      'light',
    );

    // A fresh start reads it back and applies it before anything renders.
    document.documentElement.removeAttribute('data-theme');
    apply(load());
    expect(root().dataset.theme).toBe('light');
  });

  it('resets to the defaults', async () => {
    const user = userEvent.setup();
    render(<AppearanceSection />);
    await user.selectOptions(
      section().getByLabelText(t('appearance.theme')),
      'light',
    );
    await user.click(
      section().getByRole('button', { name: t('appearance.reset') }),
    );
    expect(root().dataset.theme).toBe(resolveTheme(DEFAULTS.theme));
    expect(root().style.getPropertyValue('--font-size-mono')).toBe(
      `${DEFAULTS.monoSize}px`,
    );
  });

  it('shows a preview in the chosen editor font', async () => {
    render(<AppearanceSection />);
    const preview = await screen.findByLabelText(t('appearance.previewLabel'));
    // Carries the class the font variables are attached to.
    expect(preview.classList.contains('mono')).toBe(true);
  });
});

describe('stored appearance', () => {
  it('refuses values that would break the layout', () => {
    // These also arrive from an imported project, so they cannot be trusted.
    expect(normalise({ monoSize: 900 }).monoSize).toBe(MONO_SIZE_RANGE.max);
    expect(normalise({ monoSize: -4 }).monoSize).toBe(MONO_SIZE_RANGE.min);
    expect(normalise({ monoSize: Number.NaN }).monoSize).toBe(DEFAULTS.monoSize);
    expect(normalise({ theme: 'neon' }).theme).toBe(DEFAULTS.theme);
    // An unknown font falls back rather than writing nonsense into CSS.
    expect(normalise({ monoFamily: 'comic-sans-9000' }).monoFamily).toBe('');
  });

  it('survives unreadable storage', () => {
    localStorage.setItem('lanius.appearance', '{not json');
    expect(load()).toEqual(DEFAULTS);
  });
});

describe('window chrome', () => {
  /** Stands in for the desktop shell. */
  function fakeShell() {
    const invoke = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: { invoke },
      configurable: true,
      writable: true,
    });
    return invoke;
  }

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it('tells the window which theme to draw itself in', async () => {
    // The page repaints from CSS, but the title bar is drawn by the OS,
    // so without this the light theme left a dark bar above a light app.
    const invoke = fakeShell();
    apply({ ...DEFAULTS, theme: 'light' });
    expect(invoke).toHaveBeenCalledWith('set_window_theme', { theme: 'light' });
  });

  it('hands the window back to the system when asked to follow it', () => {
    // Resolving it here would freeze the window on whatever the system
    // was at that moment; null lets it keep following.
    const invoke = fakeShell();
    apply({ ...DEFAULTS, theme: 'system' });
    expect(invoke).toHaveBeenCalledWith('set_window_theme', { theme: null });
  });

  it('still applies the dark theme to the window', () => {
    const invoke = fakeShell();
    apply({ ...DEFAULTS, theme: 'dark' });
    expect(invoke).toHaveBeenCalledWith('set_window_theme', { theme: 'dark' });
  });

  it('works in a browser, where there is no window to set', () => {
    // No shell present: applying a theme must still style the page.
    expect(() => apply({ ...DEFAULTS, theme: 'light' })).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('does not let a failing shell take the theme change down', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('no window'));
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: { invoke },
      configurable: true,
      writable: true,
    });
    expect(() => apply({ ...DEFAULTS, theme: 'dark' })).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});

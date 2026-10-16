import { afterEach, describe, expect, it, vi } from 'vitest';

import { externalUrl, installExternalLinks } from './externalLinks';

function link(href: string, target = '_blank'): HTMLAnchorElement {
  const anchor = document.createElement('a');
  anchor.href = href;
  if (target) anchor.target = target;
  anchor.innerHTML = '<span>label</span>';
  document.body.append(anchor);
  return anchor;
}

afterEach(() => {
  document.body.innerHTML = '';
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe('external links', () => {
  it('picks only new-window web links', () => {
    expect(externalUrl(link('https://github.com/mirusu400/Lanius/releases').firstChild)).toBe(
      'https://github.com/mirusu400/Lanius/releases',
    );
    expect(externalUrl(link('https://example.test/', ''))).toBeNull();
    expect(externalUrl(link('#wiki:intro'))).toBeNull();
    expect(externalUrl(link('mailto:a@example.test'))).toBeNull();
    expect(externalUrl(document.body)).toBeNull();
  });

  it('opens them in the system browser from the desktop app', async () => {
    const invoke = vi.fn(async () => undefined);
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
    const remove = installExternalLinks();
    const anchor = link('https://github.com/mirusu400/Lanius');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    anchor.querySelector('span')!.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(invoke).toHaveBeenCalledWith('open_external', { url: 'https://github.com/mirusu400/Lanius' });
    remove();
  });

  it('leaves links alone outside the desktop app', () => {
    const remove = installExternalLinks();
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    link('https://example.test/').dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    remove();
  });
});

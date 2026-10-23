import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithI18n } from '../test-utils';
import { ExternalLink } from './ExternalLink';
import { isExternalWebUrl } from './externalUrl';

const openUrl = vi.fn<(...args: unknown[]) => Promise<void>>();

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: (...args: unknown[]) => openUrl(...args),
}));

describe('ExternalLink', () => {
  beforeEach(() => {
    openUrl.mockReset();
    openUrl.mockResolvedValue(undefined);
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: { invoke: vi.fn() },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  });

  it('opens an HTTP link through the desktop default application', async () => {
    renderWithI18n(<ExternalLink href="https://example.test/download">Download</ExternalLink>);

    fireEvent.click(screen.getByRole('link', { name: 'Download' }));

    await waitFor(() => expect(openUrl).toHaveBeenCalledWith('https://example.test/download'));
  });

  it('does not hand relative or non-web links to the operating system', () => {
    expect(isExternalWebUrl('/docs/page')).toBe(false);
    expect(isExternalWebUrl('#section')).toBe(false);
    expect(isExternalWebUrl('file:///tmp/report')).toBe(false);
    expect(isExternalWebUrl('javascript:alert(1)')).toBe(false);
    expect(isExternalWebUrl('http://mitm.it')).toBe(true);
    expect(isExternalWebUrl('https://github.com/mirusu400/Lanius')).toBe(true);
  });

  it('reports a desktop opener failure instead of silently doing nothing', async () => {
    openUrl.mockRejectedValueOnce(new Error('no browser is registered'));
    renderWithI18n(<ExternalLink href="https://example.test">Open</ExternalLink>);

    fireEvent.click(screen.getByRole('link', { name: 'Open' }));

    expect((await screen.findByRole('alert')).textContent).toContain('no browser is registered');
  });
});

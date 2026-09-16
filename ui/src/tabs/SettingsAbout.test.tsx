/** The About section: which build this is. */
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AboutSection } from './settings/AboutSection';
import type { AboutInfo } from '../api/client';
import { renderWithI18n, t } from '../test-utils';

const base: AboutInfo = {
  version: '0.1.0',
  commit: '81795cfff71ababcfd42dcb3f042614bdefdd182',
  commit_short: '81795cf',
  release: null,
  built_at: null,
  dirty: false,
  source: 'development',
};

function mockAbout(overrides: Partial<AboutInfo> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ ...base, ...overrides }),
    })) as unknown as typeof fetch,
  );
}

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe('AboutSection', () => {
  it('shows the version', async () => {
    mockAbout();
    renderWithI18n(<AboutSection />);
    expect(await screen.findByText('0.1.0')).toBeTruthy();
  });

  it('shows the commit, which is what actually identifies a build', async () => {
    // Every nightly this month reports 0.1.0.
    mockAbout();
    renderWithI18n(<AboutSection />);
    expect(await screen.findByText('81795cf')).toBeTruthy();
  });

  it('links the commit to the repository', async () => {
    mockAbout();
    renderWithI18n(<AboutSection />);
    const link = (await screen.findByText('81795cf')) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toContain(`/commit/${base.commit}`);
  });

  it('names the release when there is one', async () => {
    mockAbout({ release: 'nightly-20260915', source: 'release' });
    renderWithI18n(<AboutSection />);
    expect(await screen.findByText('nightly-20260915')).toBeTruthy();
  });

  it('says it is a development build rather than claiming a release', async () => {
    mockAbout();
    renderWithI18n(<AboutSection />);
    expect(await screen.findByText(t('about.development'))).toBeTruthy();
  });

  it('flags a build made from a modified tree', async () => {
    // The commit does not describe what is running if the tree was
    // dirty, which is exactly the confusion a bug report has to avoid.
    mockAbout({ dirty: true });
    renderWithI18n(<AboutSection />);
    expect(await screen.findByText(t('about.modified'))).toBeTruthy();
  });

  it('does not flag a clean build', async () => {
    mockAbout({ dirty: false });
    renderWithI18n(<AboutSection />);
    await screen.findByText('0.1.0');
    expect(screen.queryByText(t('about.modified'))).toBeNull();
  });

  it('copies the details as one block for pasting into a report', async () => {
    mockAbout({ release: 'nightly-20260915', source: 'release' });
    renderWithI18n(<AboutSection />);
    await userEvent.click(await screen.findByRole('button', { name: t('about.copy') }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    const text = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0];
    expect(text).toContain('0.1.0');
    expect(text).toContain('nightly-20260915');
    expect(text).toContain('81795cf');
  });

  it('says the build is modified in the copied text too', async () => {
    mockAbout({ dirty: true });
    renderWithI18n(<AboutSection />);
    await userEvent.click(await screen.findByRole('button', { name: t('about.copy') }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    expect(vi.mocked(navigator.clipboard.writeText).mock.calls[0][0]).toContain(
      'modified',
    );
  });

  it('shows the shell version in the desktop app', async () => {
    // The shell and the engine are built separately and can differ.
    mockAbout();
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: { invoke: vi.fn().mockResolvedValue({ shell_version: '0.1.0' }) },
      configurable: true,
    });
    renderWithI18n(<AboutSection />);
    expect(await screen.findByText(t('about.shell'))).toBeTruthy();
  });

  it('leaves the shell out in a browser, where there is none', async () => {
    mockAbout();
    renderWithI18n(<AboutSection />);
    await screen.findByText('0.1.0');
    expect(screen.queryByText(t('about.shell'))).toBeNull();
  });

  it('says so when the engine cannot be reached', async () => {
    // Better than an empty panel that looks broken.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch,
    );
    renderWithI18n(<AboutSection />);
    expect(await screen.findByText(t('about.unavailable'))).toBeTruthy();
  });

  it('omits a commit it does not have', async () => {
    // A build made outside a checkout with no stamp still has a version.
    mockAbout({ commit: null, commit_short: null });
    renderWithI18n(<AboutSection />);
    await screen.findByText('0.1.0');
    expect(screen.queryByText(t('about.commit'))).toBeNull();
  });
});

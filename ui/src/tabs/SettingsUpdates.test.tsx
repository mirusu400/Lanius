/** The Updates section: is there a newer build than this one? */
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import App from '../App';
import { UpdatesSection } from './settings/UpdatesSection';
import type { UpdateCheck } from '../api/client';
import { renderWithI18n, t } from '../test-utils';
import { resetUpdates, runCheck } from '../updates';

const nightly = {
  channel: 'nightly' as const,
  name: 'Nightly 20260928 (f2b2e22)',
  tag: 'nightly',
  version: null,
  commit: 'f2b2e22b1fddabc0d3bd32c4abd5b0a813dcef62',
  commit_short: 'f2b2e22',
  url: 'https://github.com/mirusu400/Lanius/releases/tag/nightly',
  published_at: '2026-09-28T10:00:00Z',
  prerelease: true,
};

const base: UpdateCheck = {
  checked_at: '2026-09-28T11:00:00+00:00',
  channel: 'nightly',
  current: {
    version: '0.1.0',
    commit: 'aaaaaaa1111111111111111111111111111111aa',
    commit_short: 'aaaaaaa',
    release: 'nightly-20260920-aaaaaaa',
    built_at: '20260920',
    dirty: false,
    source: 'release',
  },
  releases: { stable: null, nightly },
  latest: nightly,
  update_available: true,
  reason: 'behind',
  download_url: nightly.url,
};

function mockCheck(overrides: Partial<UpdateCheck> = {}) {
  // Only the update check is answered: the whole app is rendered in the
  // title bar tests, and handing every other screen this body would be
  // answering questions nobody asked.
  const fetcher = vi.fn(async (url: string) => {
    if (!String(url).includes('/api/updates')) throw new Error('not mocked');
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      url,
      json: async () => ({ ...base, ...overrides }),
    };
  });
  vi.stubGlobal('fetch', fetcher as unknown as typeof fetch);
  return fetcher;
}

beforeEach(() => {
  // The answer lives outside React so the title bar can show it too,
  // which means one test must not inherit another's.
  resetUpdates();
  window.localStorage?.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage?.clear();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

/** Pretend to be the desktop shell, which is the half that can install. */
function mockShell(handlers: Record<string, () => unknown> = {}) {
  const invoke = vi.fn(async (cmd: string) => {
    const handler = handlers[cmd];
    if (handler) return handler();
    if (cmd === 'update_progress') return { downloaded: 0, total: null };
    if (cmd === 'update_check') {
      return {
        version: '0.1.0-nightly.20260928T1009',
        current_version: '0.1.0-nightly.20260920T0800',
        date: null,
        notes: null,
      };
    }
    return null;
  });
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    value: { invoke },
    configurable: true,
  });
  return invoke;
}

describe('UpdatesSection', () => {
  it('says nothing until asked', async () => {
    // Checking is an outbound call, and this tool is often run where
    // nothing should leave the machine.
    const fetcher = mockCheck();
    renderWithI18n(<UpdatesSection />);
    expect(await screen.findByText(t('updates.never'))).toBeTruthy();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('names the newer build when the button is pressed', async () => {
    mockCheck();
    renderWithI18n(<UpdatesSection />);
    await userEvent.click(screen.getByRole('button', { name: t('updates.check') }));
    expect(
      await screen.findByText(
        t('updates.available', { name: 'Nightly 20260928 (f2b2e22)' }),
      ),
    ).toBeTruthy();
  });

  it('links to the download rather than installing anything', async () => {
    mockCheck();
    renderWithI18n(<UpdatesSection />);
    await userEvent.click(screen.getByRole('button', { name: t('updates.check') }));
    const link = (await screen.findByText(t('updates.download'))) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(nightly.url);
  });

  it('says so when this is already the newest build', async () => {
    mockCheck({ update_available: false, reason: 'current' });
    renderWithI18n(<UpdatesSection />);
    await userEvent.click(screen.getByRole('button', { name: t('updates.check') }));
    expect(await screen.findByText(t('updates.current'))).toBeTruthy();
  });

  it('does not call a local build out of date', async () => {
    // A checkout ahead of the nightly is not behind it.
    mockCheck({ update_available: true, reason: 'different' });
    renderWithI18n(<UpdatesSection />);
    await userEvent.click(screen.getByRole('button', { name: t('updates.check') }));
    expect(await screen.findByText(t('updates.different'))).toBeTruthy();
  });

  it('reports why it could not ask', async () => {
    // Offline is the usual reason and is not a failure of the app.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch,
    );
    renderWithI18n(<UpdatesSection />);
    await userEvent.click(screen.getByRole('button', { name: t('updates.check') }));
    expect(
      await screen.findByText(t('updates.failed', { message: 'offline' })),
    ).toBeTruthy();
  });

  it('shows both streams, since the newest of each is worth knowing', async () => {
    mockCheck();
    renderWithI18n(<UpdatesSection />);
    await userEvent.click(screen.getByRole('button', { name: t('updates.check') }));
    expect(await screen.findByText(t('updates.latestNightly'))).toBeTruthy();
    expect(screen.getByText(t('updates.latestStable'))).toBeTruthy();
    // Nothing tagged yet: better than an empty cell that looks broken.
    expect(screen.getByText(t('updates.none'))).toBeTruthy();
  });

  it('asks the engine to skip its cache when the button is pressed', async () => {
    // The button means "something may have changed since you last asked".
    const fetcher = mockCheck();
    renderWithI18n(<UpdatesSection />);
    await userEvent.click(screen.getByRole('button', { name: t('updates.check') }));
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect(String(fetcher.mock.calls[0][0])).toContain('refresh=true');
  });

  it('asks about the chosen stream', async () => {
    const fetcher = mockCheck();
    renderWithI18n(<UpdatesSection />);
    await userEvent.selectOptions(
      screen.getByLabelText(t('updates.channel')),
      'stable',
    );
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect(String(fetcher.mock.calls[0][0])).toContain('channel=stable');
  });

  it('remembers that automatic checks were turned off', async () => {
    // A network where nothing should leave the machine is a real place
    // to run this, and the setting has to survive a restart.
    mockCheck();
    renderWithI18n(<UpdatesSection />);
    await userEvent.click(screen.getByLabelText(t('updates.auto')));
    expect(window.localStorage.getItem('lanius.updates.auto')).toBe('off');
  });
});

describe('installing from inside the app', () => {
  it('offers to install and restart in the desktop app', async () => {
    mockShell();
    mockCheck();
    renderWithI18n(<UpdatesSection />);
    await userEvent.click(screen.getByRole('button', { name: t('updates.check') }));
    expect(
      await screen.findByRole('button', { name: t('updates.install') }),
    ).toBeTruthy();
  });

  it('offers only the download in a browser, which cannot install', async () => {
    mockCheck();
    renderWithI18n(<UpdatesSection />);
    await userEvent.click(screen.getByRole('button', { name: t('updates.check') }));
    await screen.findByText(t('updates.download'));
    expect(screen.queryByRole('button', { name: t('updates.install') })).toBeNull();
  });

  it('asks the shell to install it', async () => {
    const invoke = mockShell();
    mockCheck();
    renderWithI18n(<UpdatesSection />);
    await userEvent.click(screen.getByRole('button', { name: t('updates.check') }));
    await userEvent.click(
      await screen.findByRole('button', { name: t('updates.install') }),
    );
    await waitFor(() =>
      expect(invoke.mock.calls.map((call) => call[0])).toContain('update_install'),
    );
  });

  it('offers no install button in a build that has no updater', async () => {
    // Made without a signing key: it can say a newer build exists and
    // link to it, and a button that is going to fail is worse than none.
    mockShell({
      update_check: () => {
        throw new Error('no updater in this build');
      },
    });
    mockCheck();
    renderWithI18n(<UpdatesSection />);
    await userEvent.click(screen.getByRole('button', { name: t('updates.check') }));
    await screen.findByText(t('updates.download'));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: t('updates.install') })).toBeNull(),
    );
  });

  it('keeps the download link when the shell cannot install', async () => {
    // A build made without a signing key carries no updater, and saying
    // so beats a button that silently does nothing.
    mockShell({
      update_install: () => {
        throw new Error('no updater in this build');
      },
    });
    mockCheck();
    renderWithI18n(<UpdatesSection />);
    await userEvent.click(screen.getByRole('button', { name: t('updates.check') }));
    await userEvent.click(
      await screen.findByRole('button', { name: t('updates.install') }),
    );
    expect(
      await screen.findByText(
        t('updates.installFailed', { message: 'no updater in this build' }),
      ),
    ).toBeTruthy();
    expect(screen.getByText(t('updates.download'))).toBeTruthy();
  });
});

describe('the title bar', () => {
  it('says a newer build exists, whichever tab you are on', async () => {
    // A build that is months old looks exactly like a current one, so
    // the answer cannot live only on the screen nobody opens.
    mockCheck();
    await runCheck();
    renderWithI18n(<App />);
    expect(
      await screen.findByRole('button', { name: t('updates.pill') }),
    ).toBeTruthy();
  });

  it('says nothing while this is the newest build', async () => {
    mockCheck({ update_available: false, reason: 'current' });
    await runCheck();
    renderWithI18n(<App />);
    expect(screen.queryByRole('button', { name: t('updates.pill') })).toBeNull();
  });

  it('leads to the screen that explains it', async () => {
    mockCheck();
    await runCheck();
    renderWithI18n(<App />);
    await userEvent.click(
      await screen.findByRole('button', { name: t('updates.pill') }),
    );
    expect(
      await screen.findByRole('heading', { name: t('updates.section') }),
    ).toBeTruthy();
  });
});

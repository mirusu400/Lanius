/** Is there a newer build than this one?
 *
 * The version number cannot answer that: every nightly this month says
 * 0.1.0. Nightlies are compared by commit and releases by version, which
 * the engine does; this screen shows the answer, the link, and the
 * switch that stops it asking at all.
 */

import { useEffect, useState } from 'react';

import { useT } from '../../i18n';
import {
  autoCheckEnabled,
  channelPreference,
  lastCheckedAt,
  runCheck,
  setAutoCheckEnabled,
  setChannelPreference,
  useUpdates,
} from '../../updates';
import {
  canInstallUpdates,
  desktopUpdateCheck,
  desktopUpdateInstall,
  desktopUpdateProgress,
  type UpdateChannel,
  type UpdateOffer,
  type UpdateRelease,
} from '../../api/client';

/** How often the download is asked how far it has got. Often enough to
 *  look live, rarely enough to be free. */
const PROGRESS_INTERVAL_MS = 400;

const RELEASES = 'https://github.com/mirusu400/Lanius/releases';

/** A published build, named the way its release page names it. */
function releaseLabel(release: UpdateRelease | null): string | null {
  if (!release) return null;
  return release.name || release.tag || release.commit_short;
}

function published(value: string | null): string | null {
  if (!value) return null;
  const when = new Date(value);
  return Number.isNaN(when.getTime()) ? value : when.toLocaleDateString();
}

export function UpdatesSection() {
  const t = useT();
  const { result, error, busy } = useUpdates();
  const [channel, setChannel] = useState<UpdateChannel | 'auto'>(
    () => channelPreference() ?? 'auto',
  );
  const [auto, setAuto] = useState(autoCheckEnabled);
  const [checkedAt, setCheckedAt] = useState<number | null>(lastCheckedAt);
  // The desktop shell installs updates itself; a browser cannot, and a
  // build made without a signing key has no updater to do it with.
  const [installing, setInstalling] = useState(false);
  const [percent, setPercent] = useState<number | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const desktop = canInstallUpdates();
  // What the shell's own updater found. The engine's answer and this one
  // are different questions: the engine compares commits and can always
  // link to a download, while only a signed build with an updater in it
  // can be installed from here. A button that cannot work is worse than
  // no button, so it appears only once the shell has confirmed it.
  const [offer, setOffer] = useState<UpdateOffer | null>(null);

  // The startup check may land while this screen is open, and the
  // timestamp lives in storage rather than in the result.
  useEffect(() => {
    if (!busy) setCheckedAt(lastCheckedAt());
  }, [busy, result]);

  const available = result?.update_available && result.reason === 'behind';
  useEffect(() => {
    if (!desktop || !available) {
      setOffer(null);
      return;
    }
    let live = true;
    void desktopUpdateCheck()
      .then((found) => {
        if (live) setOffer(found);
      })
      // A build with no signing key has no updater, which is a working
      // build: it just cannot install its own replacement.
      .catch(() => {
        if (live) setOffer(null);
      });
    return () => {
      live = false;
    };
  }, [desktop, available]);

  const chooseChannel = (next: UpdateChannel | 'auto') => {
    setChannel(next);
    setChannelPreference(next === 'auto' ? null : next);
    // The answer depends on the channel, so the one on screen is now
    // about a question nobody asked.
    void runCheck({ refresh: false });
  };

  const toggleAuto = (enabled: boolean) => {
    setAuto(enabled);
    setAutoCheckEnabled(enabled);
  };

  const install = async () => {
    setInstalling(true);
    setInstallError(null);
    setPercent(null);
    // Polled rather than pushed: a few seconds of bar is not worth an
    // event channel that has to keep working across Tauri versions.
    const timer = window.setInterval(() => {
      void desktopUpdateProgress()
        .then(({ downloaded, total }) =>
          setPercent(total ? Math.min(100, Math.round((downloaded / total) * 100)) : null),
        )
        .catch(() => undefined);
    }, PROGRESS_INTERVAL_MS);
    try {
      // On Windows the installer closes the app, so this never returns;
      // everywhere else the app restarts itself onto the new build.
      await desktopUpdateInstall();
    } catch (err) {
      setInstallError(String(err instanceof Error ? err.message : err));
      setInstalling(false);
    } finally {
      window.clearInterval(timer);
    }
  };

  const installLabel = () => {
    if (!installing) return t('updates.install');
    return percent === null
      ? t('updates.installing')
      : t('updates.installProgress', { percent: String(percent) });
  };

  const latest = result?.latest ?? null;
  const verdict = () => {
    if (!result) return null;
    if (available) {
      return (
        <>
          <div className="banner">
            {t('updates.available', { name: releaseLabel(latest) ?? '' })}{' '}
            {offer && (
              <button type="button" disabled={installing} onClick={() => void install()}>
                {installLabel()}
              </button>
            )}{' '}
            <a href={latest?.url ?? result.download_url} target="_blank" rel="noreferrer">
              {t('updates.download')}
            </a>
          </div>
          {offer && <p className="muted">{t('updates.installHelp')}</p>}
          {installError && (
            // Usually a build with no signing key, or a package that
            // cannot replace itself. The download link still works.
            <div className="banner error">
              {t('updates.installFailed', { message: installError })}
            </div>
          )}
        </>
      );
    }
    if (result.reason === 'different') {
      // A local or unpublished commit is not out of date, but it is not
      // the build anyone else is running either.
      return <p className="muted">{t('updates.different')}</p>;
    }
    if (result.reason === 'current') return <p className="muted">{t('updates.current')}</p>;
    return <p className="muted">{t('updates.unknown')}</p>;
  };

  return (
    <section>
      <h3>{t('updates.section')}</h3>
      <p className="muted">{t('updates.help')}</p>

      <div className="settings-row">
        <label htmlFor="update-channel">{t('updates.channel')}</label>
        <select
          id="update-channel"
          value={channel}
          onChange={(event) =>
            chooseChannel(event.target.value as UpdateChannel | 'auto')
          }
        >
          <option value="auto">{t('updates.channelAuto')}</option>
          <option value="stable">{t('updates.channelStable')}</option>
          <option value="nightly">{t('updates.channelNightly')}</option>
        </select>
        <button type="button" disabled={busy} onClick={() => void runCheck({ refresh: true })}>
          {busy ? t('updates.checking') : t('updates.check')}
        </button>
      </div>

      {error && <div className="banner error">{t('updates.failed', { message: error })}</div>}
      {verdict()}

      <dl className="settings-grid mono">
        <dt>{t('updates.latestStable')}</dt>
        <dd>
          <ReleaseCell release={result?.releases?.stable ?? null} />
        </dd>
        <dt>{t('updates.latestNightly')}</dt>
        <dd>
          <ReleaseCell release={result?.releases?.nightly ?? null} />
        </dd>
      </dl>

      <div className="settings-row">
        <label>
          <input
            type="checkbox"
            checked={auto}
            onChange={(event) => toggleAuto(event.target.checked)}
          />{' '}
          {t('updates.auto')}
        </label>
      </div>
      <p className="muted">{t('updates.autoHelp')}</p>

      <div className="settings-row">
        <span className="muted">
          {checkedAt
            ? t('updates.lastChecked', { when: new Date(checkedAt).toLocaleString() })
            : t('updates.never')}
        </span>
        <a href={RELEASES} target="_blank" rel="noreferrer">
          {t('updates.allReleases')}
        </a>
      </div>
    </section>
  );
}

function ReleaseCell({ release }: { release: UpdateRelease | null }) {
  const t = useT();
  const label = releaseLabel(release);
  if (!release || !label) return <span className="muted">{t('updates.none')}</span>;
  const when = published(release.published_at);
  return (
    <>
      {release.url ? (
        <a href={release.url} target="_blank" rel="noreferrer">
          {label}
        </a>
      ) : (
        label
      )}
      {when && <span className="muted"> {t('updates.published', { date: when })}</span>}
    </>
  );
}

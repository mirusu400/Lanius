/** Which build this is.
 *
 * Every nightly this month reports version 0.1.0, so the version alone
 * does not tell anyone what they are running. The commit does, and so
 * does knowing whether this came from a release or from somebody's
 * checkout. All of it is here to be pasted into a bug report.
 */

import { useEffect, useState } from "react";

import { getAbout, getShellVersion, type AboutInfo } from "../../api/client";
import { useT } from "../../i18n";

/** The repository, for linking a commit to what is in it. */
const REPO = "https://github.com/mirusu400/Lanius";

export function AboutSection() {
  const t = useT();
  const [about, setAbout] = useState<AboutInfo | null>(null);
  const [shell, setShell] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    getAbout()
      .then(setAbout)
      .catch(() => setAbout(null));
    getShellVersion()
      .then(setShell)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  if (!about) {
    return (
      <section>
        <h3>{t("about.section")}</h3>
        <p className="muted">{t("about.unavailable")}</p>
      </section>
    );
  }

  /** The same facts as one block, which is what a bug report wants. */
  const summary = [
    `Lanius ${about.version}`,
    about.release ? `release ${about.release}` : "development build",
    about.commit
      ? `commit ${about.commit_short}${about.dirty ? " (modified)" : ""}`
      : null,
    shell ? `shell ${shell}` : null,
    about.built_at ? `built ${about.built_at}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <section>
      <h3>{t("about.section")}</h3>
      <p className="muted">{t("about.help")}</p>

      <dl className="settings-grid mono">
        <dt>{t("about.version")}</dt>
        <dd>{about.version}</dd>

        <dt>{t("about.build")}</dt>
        <dd>
          {about.release ?? t("about.development")}
          {/* A development build is not the release that happens to be
              tagged, and saying so avoids a confusing bug report. */}
          {about.dirty && <span className="pill">{t("about.modified")}</span>}
        </dd>

        {about.commit && (
          <>
            <dt>{t("about.commit")}</dt>
            <dd>
              <a
                href={`${REPO}/commit/${about.commit}`}
                target="_blank"
                rel="noreferrer"
              >
                {about.commit_short}
              </a>
            </dd>
          </>
        )}

        {about.built_at && (
          <>
            <dt>{t("about.builtAt")}</dt>
            <dd>{about.built_at}</dd>
          </>
        )}

        {shell && (
          <>
            {/* The shell and the engine are built separately and can be
                different versions of each other. */}
            <dt>{t("about.shell")}</dt>
            <dd>{shell}</dd>
          </>
        )}
      </dl>

      <div className="settings-row">
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(summary)
              .then(() => setCopied(true));
          }}
        >
          {copied ? t("about.copied") : t("about.copy")}
        </button>
        <a href={REPO} target="_blank" rel="noreferrer">
          {t("about.repository")}
        </a>
      </div>
    </section>
  );
}

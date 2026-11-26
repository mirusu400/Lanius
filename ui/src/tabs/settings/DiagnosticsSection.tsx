/** Errors recorded on this machine, and a way to hand them to the developer.
 *
 * Nothing is uploaded. The user saves a bundle and attaches it to an issue
 * themselves, after seeing here exactly what it contains: the list below is
 * the same redacted text the bundle carries.
 */

import { useCallback, useEffect, useState } from "react";

import { openUrl } from "@tauri-apps/plugin-opener";

import {
  clearDiagnostics,
  createIssueUrl,
  downloadDiagnosticsBundle,
  getDiagnostics,
  getShellVersion,
  isDesktop,
  saveDesktopDiagnosticsBundle,
  type DiagnosticReport,
} from "../../api/client";
import { useToast } from "../../components/Toast";
import { useT } from "../../i18n";

function bundleName(): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const d = new Date();
  return `lanius-diagnostics-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
    + `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.zip`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function DiagnosticsSection() {
  const t = useT();
  const { showToast } = useToast();
  const [reports, setReports] = useState<DiagnosticReport[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    getDiagnostics()
      .then((result) => setReports(result.items))
      .catch(() => setReports(null));
  }, []);

  useEffect(load, [load]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      const message = errorText(error);
      // Lockdown refusals already raise the shared toast.
      if (!message.includes("Lockdown")) {
        showToast({ message: t("diagnostics.failed", { message }), tone: "error" });
      }
    } finally {
      setBusy(false);
    }
  };

  const save = () => run(async () => {
    const name = bundleName();
    if (isDesktop()) {
      const path = await saveDesktopDiagnosticsBundle(name, t("diagnostics.saveTitle"));
      if (path) showToast({ message: t("diagnostics.saved", { path }), tone: "success" });
      return;
    }
    const blob = await downloadDiagnosticsBundle();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  });

  const openIssue = () => run(async () => {
    const { url } = await createIssueUrl(await getShellVersion());
    if (isDesktop()) {
      await openUrl(url);
    } else {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  });

  const clear = () => run(async () => {
    await clearDiagnostics();
    load();
  });

  return (
    <section>
      <h3>{t("diagnostics.section")}</h3>
      <p className="muted">{t("diagnostics.help")}</p>
      <p className="muted">{t("diagnostics.privacy")}</p>

      {reports === null ? (
        <p className="muted">{t("diagnostics.unavailable")}</p>
      ) : reports.length === 0 ? (
        <p className="muted">{t("diagnostics.empty")}</p>
      ) : (
        <>
          <p>{t("diagnostics.count", { count: reports.length })}</p>
          <ul className="diagnostics-reports">
            {reports.slice(0, 10).map((report) => (
              <li key={report.id}>
                <details>
                  <summary>
                    <span className="pill">{t(`diagnostics.source.${report.source}`)}</span>
                    <span className="mono">{new Date(report.time).toLocaleString()}</span>
                    <span className="mono diagnostics-message">
                      {report.kind}{report.message ? `: ${report.message.split("\n")[0]}` : ""}
                    </span>
                  </summary>
                  <pre className="mono">{report.traceback || report.message}</pre>
                </details>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="settings-row">
        <button type="button" disabled={busy} onClick={() => void save()}>
          {t("diagnostics.save")}
        </button>
        <button type="button" disabled={busy} onClick={() => void openIssue()}>
          {t("diagnostics.issue")}
        </button>
        <button type="button" disabled={busy} onClick={load}>
          {t("diagnostics.refresh")}
        </button>
        <button type="button" disabled={busy || !reports?.length} onClick={() => void clear()}>
          {t("diagnostics.clear")}
        </button>
      </div>
      <p className="muted">{t("diagnostics.issueHelp")}</p>
    </section>
  );
}

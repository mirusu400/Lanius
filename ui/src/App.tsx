import { useCallback, useEffect, useMemo, useState } from "react";
import { isDesktop, putWorkspace } from "./api/client";
import { ProjectPicker } from "./ProjectPicker";
import { closeProject, currentProject, type Project } from "./projects";

import { DashboardTab } from "./tabs/DashboardTab";
import { ProxyTab } from "./tabs/ProxyTab";
import { RepeaterTabView } from "./tabs/RepeaterTab";
import { TargetTab } from "./tabs/TargetTab";
import { IntruderTab } from "./tabs/IntruderTab";
import { DecoderTab } from "./tabs/DecoderTab";
import { ComparerTab } from "./tabs/ComparerTab";
import { PluginsTab } from "./tabs/PluginsTab";
import { LoggerTab } from "./tabs/LoggerTab";
import { SettingsTab } from "./tabs/SettingsTab";
import { DocsTab } from "./tabs/DocsTab";
import { useT } from "./i18n";
import { autosave, flushAutosaves } from "./tabs/autosave";
import {
  getTabs,
  resetTabs,
  setTabs,
  subscribe as subscribeRepeater,
} from "./tabs/repeaterStore";
import {
  getDecoderTabs,
  resetDecoderTabs,
  setDecoderTabs,
  subscribe as subscribeDecoder,
} from "./tabs/decoderStore";
import { BusyProvider } from "./components/busy";
import { Spinner, useDelayedBusy } from "./components/Spinner";
import { useShortcuts } from "./useShortcut";
import "./App.css";

const TABS = [
  "Dashboard",
  "Proxy",
  "Target",
  "Repeater",
  "Intruder",
  "Decoder",
  "Comparer",
  "Logger",
  "Plugins",
  "Settings",
  "Docs",
] as const;

export type Tab = (typeof TABS)[number];

export default function App() {
  const desktop = isDesktop();
  const [project, setProject] = useState<Project | null>(null);
  const [checking, setChecking] = useState(desktop);

  useEffect(() => {
    if (!desktop) return;
    void currentProject()
      .then(setProject)
      .catch(() => setProject(null))
      .finally(() => setChecking(false));
  }, [desktop]);

  const leaveProject = async () => {
    // Persist the editor tabs before stopping the engine. The regular
    // autosave is debounced and may still have a pending write.
    await flushAutosaves();
    await Promise.all([
      putWorkspace('repeater', getTabs()),
      putWorkspace('decoder', getDecoderTabs()),
    ]);
    await closeProject();
    setProject(null);
    resetTabs();
    resetDecoderTabs();
  };

  if (checking) return <div className="project-picker" />;
  if (desktop && !project) return <ProjectPicker onOpen={setProject} />;
  return <WorkspaceApp project={project} onLeave={leaveProject} />;
}

function WorkspaceApp({ project, onLeave }: { project: Project | null; onLeave: () => Promise<void> }) {
  const t = useT();
  const [tab, setTab] = useState<Tab>("Dashboard");
  const [busy, setBusy] = useState(false);
  // Held back until the wait is long enough to notice, so a tab that
  // loads in a few frames does not flash a spinner.
  const showSpinner = useDelayedBusy(busy);
  const onBusyChange = useCallback((value: boolean) => setBusy(value), []);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const navigationShortcuts = useMemo<Record<string, () => void>>(
    () => Object.fromEntries(
      TABS.map((name) => [`app.${name.toLowerCase()}`, () => setTab(name)]),
    ),
    [],
  );
  useShortcuts(navigationShortcuts, !switching);

  const switchProject = async () => {
    if (switching) return;
    setSwitching(true);
    setSwitchError(null);
    try {
      await onLeave();
    } catch (err) {
      setSwitchError(String(err));
      setSwitching(false);
    }
  };

  // Persist what you were working on, so closing Lanius does not throw
  // away your open requests.
  useEffect(() => {
    const stop = [
      autosave(
        "repeater",
        (listener) => subscribeRepeater(() => listener(getTabs())),
        setTabs,
      ),
      autosave(
        "decoder",
        (listener) => subscribeDecoder(() => listener(getDecoderTabs())),
        setDecoderTabs,
      ),
    ];
    return () => stop.forEach((fn) => fn());
  }, []);

  return (
    <div className={switching ? "app switching" : "app"}>
      <header className="titlebar">
        <button
          type="button"
          className={tab === "Dashboard" ? "brand active" : "brand"}
          onClick={() => setTab("Dashboard")}
          aria-label={t("dash.home")}
        >
          Lanius
        </button>
        <nav className="tabs">
          {TABS.map((name) => (
            <button
              key={name}
              className={name === tab ? "tab active" : "tab"}
              onClick={() => setTab(name)}
            >
              {name === "Dashboard"
                ? t("dash.title")
                : name === "Docs"
                  ? t("docs.title")
                  : name}
            </button>
          ))}
        </nav>
        {showSpinner && <Spinner />}
      </header>
      <main className="content">
        <BusyProvider onChange={onBusyChange}>
          {tab === "Dashboard" ? (
            <DashboardTab onOpenTab={(next) => setTab(next as Tab)} />
          ) : tab === "Proxy" ? (
            <ProxyTab />
          ) : tab === "Target" ? (
            <TargetTab />
          ) : tab === "Repeater" ? (
            <RepeaterTabView />
          ) : tab === "Intruder" ? (
            <IntruderTab />
          ) : tab === "Decoder" ? (
            <DecoderTab />
          ) : tab === "Comparer" ? (
            <ComparerTab />
          ) : tab === "Plugins" ? (
            <PluginsTab />
          ) : tab === "Logger" ? (
            <LoggerTab />
          ) : tab === "Settings" ? (
            <SettingsTab
              project={project}
              onSwitchProject={switchProject}
              switchingProject={switching}
              switchError={switchError}
            />
          ) : tab === "Docs" ? (
            <DocsTab />
          ) : null}
        </BusyProvider>
      </main>
    </div>
  );
}

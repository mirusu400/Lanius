import { Activity, useCallback, useEffect, useMemo, useReducer, useRef, useState, type DragEvent } from "react";
import { captureWindowToClipboard, getLockdown, getScannerState, isDesktop, putWorkspace } from "./api/client";
import { LOCKDOWN_BLOCKED, LOCKDOWN_CHANGED } from "./lockdownEvents";
import { connectStream } from "./api/stream";
import { ProjectPicker } from "./ProjectPicker";
import { closeProject, currentProject, type Project } from "./projects";
import {
  DEFAULT_TAB_ORDER,
  loadTabOrder,
  moveTab,
  saveTabOrder,
  type DropSide,
  type Tab,
} from "./tabOrder";

import { DashboardTab } from "./tabs/DashboardTab";
import { ProxyTab } from "./tabs/ProxyTab";
import { ReplayTabView } from "./tabs/ReplayTab";
import { TargetTab } from "./tabs/TargetTab";
import { IssuesTab } from "./tabs/IssuesTab";
import { FuzzerTab } from "./tabs/FuzzerTab";
import { DecoderTab } from "./tabs/DecoderTab";
import { DiffTab } from "./tabs/DiffTab";
import { PluginsTab } from "./tabs/PluginsTab";
import { LoggerTab } from "./tabs/LoggerTab";
import { SettingsTab } from "./tabs/SettingsTab";
import { DocsTab } from "./tabs/DocsTab";
import { useT } from "./i18n";
import { flushAutosaves } from "./tabs/autosave";
import { startWorkspaceAutosaves } from "./tabs/workspace";
import {
  getTabs,
  resetTabs,
} from "./tabs/replayStore";
import {
  getDecoderTabs,
  resetDecoderTabs,
} from "./tabs/decoderStore";
import { BusyProvider } from "./components/busy";
import { Spinner, useDelayedBusy } from "./components/Spinner";
import { useToast } from "./components/Toast";
import { DesktopClose } from "./components/DesktopClose";
import { useShortcut, useShortcuts } from "./useShortcut";
import { autoCheck, useUpdates } from "./updates";
import "./App.css";
import "./themePresets.css";

export type { Tab } from "./tabOrder";

export default function App() {
  const t = useT();
  const desktop = isDesktop();
  const [project, setProject] = useState<Project | null>(null);
  const [checking, setChecking] = useState(desktop);
  const { showToast, dismissToast } = useToast();
  const capturingScreenshot = useRef(false);

  const captureScreenshot = useCallback(() => {
    if (capturingScreenshot.current) return;
    capturingScreenshot.current = true;
    dismissToast();

    void (async () => {
      // Let React remove an earlier toast before the snapshot. Timers also run
      // when WebKit pauses animation frames for a window in the background.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
      try {
        await captureWindowToClipboard();
        showToast({ message: t('screenshot.copied'), tone: 'success' });
      } catch (error) {
        console.error('Window capture failed', error);
        showToast({ message: t('screenshot.failed'), tone: 'error' });
      } finally {
        capturingScreenshot.current = false;
      }
    })();
  }, [dismissToast, showToast, t]);
  useShortcut('app.screenshot', captureScreenshot, desktop);

  useEffect(() => {
    const blocked = () => showToast({ message: t('lockdown.blocked'), tone: 'error' });
    window.addEventListener(LOCKDOWN_BLOCKED, blocked);
    return () => window.removeEventListener(LOCKDOWN_BLOCKED, blocked);
  }, [showToast, t]);

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
      putWorkspace('replay', getTabs()),
      putWorkspace('decoder', getDecoderTabs()),
    ]);
    await closeProject();
    setProject(null);
    resetTabs();
    resetDecoderTabs();
  };

  const content = checking
    ? <div className="project-picker" />
    : desktop && !project
      ? <ProjectPicker onOpen={setProject} />
      : <WorkspaceApp project={project} onLeave={leaveProject} />;
  return <>{content}{desktop && <DesktopClose />}</>;
}

function WorkspaceApp({ project, onLeave }: { project: Project | null; onLeave: () => Promise<void> }) {
  const t = useT();
  // Mount a workspace tab on its first visit, then hide it with Activity.
  // React keeps its filters, drafts, selections and scroll position while
  // pausing subscriptions and polling for tabs that are out of view.
  const [{ tab, visited }, setTab] = useReducer(
    (current: { tab: Tab; visited: Set<Tab> }, update: Tab | ((tab: Tab) => Tab)) => {
      const next = typeof update === 'function' ? update(current.tab) : update;
      if (next === current.tab) return current;
      return { tab: next, visited: new Set([...current.visited, next]) };
    },
    { tab: 'Dashboard' as Tab, visited: new Set<Tab>(['Dashboard', 'Proxy']) },
  );
  const [historyMethodRequest, setHistoryMethodRequest] = useState<{ method: string } | null>(null);
  const [tabOrder, setTabOrder] = useState<Tab[]>(loadTabOrder);
  const [scannerAvailable, setScannerAvailable] = useState(false);
  const [draggedTab, setDraggedTab] = useState<Tab | null>(null);
  const [dropTarget, setDropTarget] = useState<{ tab: Tab; side: DropSide } | null>(null);
  const [busy, setBusy] = useState(false);
  // Held back until the wait is long enough to notice, so a tab that
  // loads in a few frames does not flash a spinner.
  const showSpinner = useDelayedBusy(busy);
  const onBusyChange = useCallback((value: boolean) => setBusy(value), []);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  // Which Settings screen to land on when something sends you there.
  const [settingsGroup, setSettingsGroup] = useState<string | null>(null);
  const consumeSettingsGroup = useCallback(() => setSettingsGroup(null), []);
  const { result: updates } = useUpdates();
  const updateAvailable = updates?.update_available ?? false;
  const [lockdownActive, setLockdownActive] = useState(false);
  const { showToast } = useToast();

  const refreshScannerAvailability = useCallback(() => {
    void getScannerState()
      .then((state) => {
        const available = state.passive_checks.length > 0 || state.active_checks.length > 0;
        setScannerAvailable(available);
        if (!available) setTab((current) => current === 'Issues' ? 'Dashboard' : current);
      })
      .catch(() => {
        setScannerAvailable(false);
        setTab((current) => current === 'Issues' ? 'Dashboard' : current);
      });
  }, []);

  useEffect(() => {
    refreshScannerAvailability();
  }, [project?.id, refreshScannerAvailability]);

  useEffect(() => connectStream({
    onEvent: (event) => {
      if (event.type === 'plugins.changed') {
        refreshScannerAvailability();
        return;
      }
      if (event.type !== 'engine.scope_egress_blocked') return;
      const target = event.data.port === null
        ? event.data.host
        : `${event.data.host}:${event.data.port}`;
      showToast({
        message: t('lockdown.scopeEgressBlocked', { target }),
        tone: 'error',
      });
    },
  }), [project?.id, refreshScannerAvailability, showToast, t]);

  useEffect(() => {
    let live = true;
    const refresh = () => {
      void getLockdown()
        .then((status) => { if (live) setLockdownActive(status.effective); })
        .catch(() => { if (live) setLockdownActive(false); });
    };
    refresh();
    window.addEventListener(LOCKDOWN_CHANGED, refresh);
    return () => {
      live = false;
      window.removeEventListener(LOCKDOWN_CHANGED, refresh);
    };
  }, [project?.id]);

  // A build that is months old looks exactly like a current one, so ask
  // once on startup. Off by one checkbox in Settings, and at most once
  // every six hours.
  useEffect(() => {
    void autoCheck();
  }, []);

  const openUpdates = () => {
    setSettingsGroup("about");
    setTab("Settings");
  };
  const openLockdown = () => {
    setSettingsGroup("security");
    setTab("Settings");
  };
  const visibleTabs = useMemo(
    () => tabOrder.filter((name) => name !== 'Issues' || scannerAvailable),
    [scannerAvailable, tabOrder],
  );
  const navigationShortcuts = useMemo<Record<string, () => void>>(
    () => Object.fromEntries(
      DEFAULT_TAB_ORDER.map((name) => [`app.${name.toLowerCase()}`, () => setTab(name)]),
    ),
    [],
  );
  useShortcuts(navigationShortcuts, !switching);

  const dragOverTab = (event: DragEvent<HTMLButtonElement>, target: Tab) => {
    if (!draggedTab || draggedTab === target) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const bounds = event.currentTarget.getBoundingClientRect();
    const side: DropSide = event.clientX < bounds.left + bounds.width / 2
      ? 'before'
      : 'after';
    setDropTarget({ tab: target, side });
  };

  const dropTab = (event: DragEvent<HTMLButtonElement>, target: Tab) => {
    event.preventDefault();
    if (!draggedTab || draggedTab === target) return;
    const side = dropTarget?.tab === target ? dropTarget.side : 'before';
    setTabOrder((current) => {
      const next = moveTab(current, draggedTab, target, side);
      saveTabOrder(next);
      return next;
    });
    setDraggedTab(null);
    setDropTarget(null);
  };

  const finishDragging = () => {
    setDraggedTab(null);
    setDropTarget(null);
  };

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
  useEffect(startWorkspaceAutosaves, []);

  return (
    <div className={switching ? "app switching" : "app"}>
      <header className="titlebar">
        <button
          type="button"
          className={tab === "Dashboard" ? "brand active" : "brand"}
          onClick={() => setTab("Dashboard")}
          aria-label={t("dash.home")}
        >
          <span className="brand-mark" aria-hidden="true" />
        </button>
        <nav className="tabs">
          {visibleTabs.map((name) => (
            <button
              key={name}
              className={[
                'tab',
                name === tab ? 'active' : '',
                name === draggedTab ? 'dragging' : '',
                dropTarget?.tab === name ? `drop-${dropTarget.side}` : '',
              ].filter(Boolean).join(' ')}
              draggable
              aria-grabbed={name === draggedTab}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', name);
                setDraggedTab(name);
              }}
              onDragOver={(event) => dragOverTab(event, name)}
              onDrop={(event) => dropTab(event, name)}
              onDragEnd={finishDragging}
              onClick={() => {
                if (name === "Settings") setSettingsGroup(null);
                setTab(name);
              }}
            >
              {name === "Dashboard"
                ? t("dash.title")
                : name === "Issues"
                  ? t("issues.title")
                : name === "Docs"
                  ? t("docs.title")
                  : name}
              {/* A new build is worth one dot, wherever you are. */}
              {name === "Settings" && updateAvailable && (
                <span className="tab-dot" aria-label={t("updates.badge")} />
              )}
            </button>
          ))}
        </nav>
        {lockdownActive && (
          <button type="button" className="lockdown-pill" onClick={openLockdown}>
            {t('lockdown.title')}
          </button>
        )}
        {updateAvailable && (
          <button type="button" className="update-pill" onClick={openUpdates}>
            {t("updates.pill")}
          </button>
        )}
        {showSpinner && <Spinner />}
      </header>
      <main className="content">
        <BusyProvider onChange={onBusyChange}>
          <Activity mode={tab === "Proxy" ? "visible" : "hidden"}>
            <ProxyTab methodFilterRequest={historyMethodRequest} />
          </Activity>
          <Activity mode={tab === "Dashboard" ? "visible" : "hidden"}>
            <DashboardTab
              onOpenTab={(next) => setTab(next as Tab)}
              onOpenSettings={(group) => {
                setSettingsGroup(group);
                setTab('Settings');
              }}
              onOpenMethod={(method) => {
                setHistoryMethodRequest({ method });
                setTab('Proxy');
              }}
            />
          </Activity>
          {visited.has('Target') && <Activity mode={tab === 'Target' ? 'visible' : 'hidden'}><TargetTab /></Activity>}
          {visited.has('Issues') && <Activity mode={tab === 'Issues' ? 'visible' : 'hidden'}><IssuesTab /></Activity>}
          {visited.has('Replay') && <Activity mode={tab === 'Replay' ? 'visible' : 'hidden'}><ReplayTabView /></Activity>}
          {visited.has('Fuzzer') && <Activity mode={tab === 'Fuzzer' ? 'visible' : 'hidden'}><FuzzerTab /></Activity>}
          {visited.has('Decoder') && <Activity mode={tab === 'Decoder' ? 'visible' : 'hidden'}><DecoderTab /></Activity>}
          {visited.has('Diff') && <Activity mode={tab === 'Diff' ? 'visible' : 'hidden'}><DiffTab /></Activity>}
          {visited.has('Plugins') && <Activity mode={tab === 'Plugins' ? 'visible' : 'hidden'}><PluginsTab /></Activity>}
          {visited.has('Logger') && <Activity mode={tab === 'Logger' ? 'visible' : 'hidden'}><LoggerTab /></Activity>}
          {visited.has('Settings') && (
            <Activity mode={tab === 'Settings' ? 'visible' : 'hidden'}>
              <SettingsTab
                openGroup={settingsGroup}
                onGroupOpened={consumeSettingsGroup}
                project={project}
                onSwitchProject={switchProject}
                switchingProject={switching}
                switchError={switchError}
              />
            </Activity>
          )}
          {visited.has('Docs') && <Activity mode={tab === 'Docs' ? 'visible' : 'hidden'}><DocsTab /></Activity>}
        </BusyProvider>
      </main>
    </div>
  );
}

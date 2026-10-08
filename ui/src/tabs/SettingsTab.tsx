/** Settings, grouped by what you came here to do.
 *
 * These were eleven sections stacked on one page, which meant scrolling
 * past everything else to reach any one of them. They are grouped the
 * way the rest of the app already groups things, with sub-tabs, so each
 * screen holds one topic.
 *
 * Each section owns its own loading and saving, so a group is just a
 * list of sections and nothing has to be threaded through here.
 */

import { Activity, useEffect, useState } from "react";

import { useT } from "../i18n";
import type { Project } from "../projects";
import { AboutSection } from "./settings/AboutSection";
import { AppearanceSection } from "./settings/AppearanceSection";
import { BrowserHelpSection } from "./settings/BrowserHelpSection";
import { BrowserSection } from "./settings/BrowserSection";
import { BodyDisplaySection } from "./settings/BodyDisplaySection";
import { CaptureStorageSection } from "./settings/CaptureStorageSection";
import { CaSection } from "./settings/CaSection";
import { CaptureSection } from "./settings/CaptureSection";
import { EngineSection } from "./settings/EngineSection";
import { LanguageSection } from "./settings/LanguageSection";
import { LockdownSection } from "./settings/LockdownSection";
import { ListenerSection } from "./settings/ListenerSection";
import { McpSection } from "./settings/McpSection";
import { MatchReplaceSection } from "./settings/MatchReplaceSection";
import { ProjectSection } from "./settings/ProjectSection";
import { ProjectCompactSection } from "./settings/ProjectCompactSection";
import { ShortcutsSection } from "./settings/ShortcutsSection";
import { TlsSection } from "./settings/TlsSection";
import { TlsTrustSection } from "./settings/TlsTrustSection";
import { UpdatesSection } from "./settings/UpdatesSection";
import { UpstreamSection } from "./settings/UpstreamSection";

const GROUPS = [
  "proxy",
  "shortcuts",
  "browser",
  "appearance",
  "integrations",
  "security",
  "project",
  "about",
] as const;
type Group = (typeof GROUPS)[number];

/** Where the chosen group is remembered, so a reload does not drop you
 *  back at the first one while you are in the middle of something. */
const STORAGE_KEY = "lanius.settings.group";

function initialGroup(): Group {
  const stored = window.localStorage?.getItem(STORAGE_KEY);
  return GROUPS.includes(stored as Group) ? (stored as Group) : "proxy";
}

interface SettingsTabProps {
  project?: Project | null;
  /** Which group to open on, when something else sent you here: the
   *  update badge in the title bar means the About screen. */
  openGroup?: string | null;
  onGroupOpened?: () => void;
  onSwitchProject?: () => Promise<void>;
  switchingProject?: boolean;
  switchError?: string | null;
  onProjectImported?: () => void;
}

export function SettingsTab({ project, onSwitchProject, switchingProject = false, switchError, openGroup, onGroupOpened, onProjectImported }: SettingsTabProps = {}) {
  const t = useT();
  const [group, setGroup] = useState<Group>(() =>
    GROUPS.includes(openGroup as Group) ? (openGroup as Group) : initialGroup(),
  );
  const [visitedGroups, setVisitedGroups] = useState<Set<Group>>(() => new Set([
    GROUPS.includes(openGroup as Group) ? (openGroup as Group) : initialGroup(),
  ]));
  const [error, setError] = useState<string | null>(null);
  const [importRevision, setImportRevision] = useState(0);

  useEffect(() => {
    if (!GROUPS.includes(openGroup as Group)) return;
    setGroup(openGroup as Group);
    setVisitedGroups((current) => new Set([...current, openGroup as Group]));
    onGroupOpened?.();
  }, [openGroup, onGroupOpened]);

  const choose = (next: Group) => {
    setGroup(next);
    setVisitedGroups((current) => new Set([...current, next]));
    window.localStorage?.setItem(STORAGE_KEY, next);
  };

  return (
    <div className="settings-tab">
      <div className="subtabs">
        {GROUPS.map((name) => (
          <button
            key={name}
            className={group === name ? "active" : ""}
            onClick={() => choose(name)}
          >
            {t(`settings.group.${name}`)}
          </button>
        ))}
      </div>

      {error && <div className="banner error">{error}</div>}

      <div className="settings-body">
        {/* Everything about getting traffic into Lanius. */}
        {visitedGroups.has("proxy") && <Activity mode={group === "proxy" ? "visible" : "hidden"}>
          <>
            <ListenerSection />
            <UpstreamSection />
            <TlsTrustSection />
            <BodyDisplaySection />
            <CaptureStorageSection />
            <MatchReplaceSection />
            <EngineSection />
            <CaptureSection />
            <TlsSection />
          </>
        </Activity>}

        {/* Everything about pointing a browser at it. */}
        {visitedGroups.has("browser") && <Activity mode={group === "browser" ? "visible" : "hidden"}>
          <>
            <BrowserSection />
            <CaSection onError={setError} />
            <BrowserHelpSection />
          </>
        </Activity>}

        {visitedGroups.has("shortcuts") && <Activity mode={group === "shortcuts" ? "visible" : "hidden"}><ShortcutsSection /></Activity>}

        {visitedGroups.has("appearance") && <Activity mode={group === "appearance" ? "visible" : "hidden"}>
          <>
            <AppearanceSection />
            <LanguageSection />
          </>
        </Activity>}

        {visitedGroups.has("integrations") && <Activity mode={group === "integrations" ? "visible" : "hidden"}><McpSection /></Activity>}

        {visitedGroups.has("security") && <Activity mode={group === "security" ? "visible" : "hidden"}><LockdownSection /></Activity>}

        {visitedGroups.has("project") && <Activity mode={group === "project" ? "visible" : "hidden"}>
          <>
            <ProjectSection
              project={project}
              onSwitchProject={onSwitchProject}
              switchingProject={switchingProject}
              switchError={switchError}
              onProjectImported={() => {
                setImportRevision((revision) => revision + 1);
                onProjectImported?.();
              }}
            />
            <ProjectCompactSection key={importRevision} />
          </>
        </Activity>}

        {visitedGroups.has("about") && <Activity mode={group === "about" ? "visible" : "hidden"}>
          <>
            <AboutSection />
            <UpdatesSection />
          </>
        </Activity>}
      </div>
    </div>
  );
}

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

import { useState } from "react";

import { useT } from "../i18n";
import type { Project } from "../projects";
import { AboutSection } from "./settings/AboutSection";
import { AppearanceSection } from "./settings/AppearanceSection";
import { BrowserHelpSection } from "./settings/BrowserHelpSection";
import { BrowserSection } from "./settings/BrowserSection";
import { BodyDisplaySection } from "./settings/BodyDisplaySection";
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
  onSwitchProject?: () => Promise<void>;
  switchingProject?: boolean;
  switchError?: string | null;
}

export function SettingsTab({ project, onSwitchProject, switchingProject = false, switchError, openGroup }: SettingsTabProps = {}) {
  const t = useT();
  const [group, setGroup] = useState<Group>(() =>
    GROUPS.includes(openGroup as Group) ? (openGroup as Group) : initialGroup(),
  );
  const [error, setError] = useState<string | null>(null);

  const choose = (next: Group) => {
    setGroup(next);
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
        {group === "proxy" && (
          <>
            <ListenerSection />
            <UpstreamSection />
            <BodyDisplaySection />
            <MatchReplaceSection />
            <EngineSection />
            <CaptureSection />
            <TlsSection />
          </>
        )}

        {/* Everything about pointing a browser at it. */}
        {group === "browser" && (
          <>
            <BrowserSection />
            <CaSection onError={setError} />
            <BrowserHelpSection />
          </>
        )}

        {group === "shortcuts" && <ShortcutsSection />}

        {group === "appearance" && (
          <>
            <AppearanceSection />
            <LanguageSection />
          </>
        )}

        {group === "integrations" && <McpSection />}

        {group === "security" && <LockdownSection />}

        {group === "project" && (
          <>
            <ProjectSection
              project={project}
              onSwitchProject={onSwitchProject}
              switchingProject={switchingProject}
              switchError={switchError}
            />
            <ProjectCompactSection />
          </>
        )}

        {group === "about" && (
          <>
            <AboutSection />
            <UpdatesSection />
          </>
        )}
      </div>
    </div>
  );
}

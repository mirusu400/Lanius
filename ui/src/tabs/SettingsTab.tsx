/** Settings groups and searchable sections. Sections own loading and saving. */

import { Activity, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

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
import { SettingsSearch } from "./settings/SettingsSearch";
import { SETTINGS_GROUPS, SETTINGS_SECTIONS, type SettingsGroup, type SettingsSection, type SettingsSectionId } from "./settings/settingsCatalogue";

const GROUPS = SETTINGS_GROUPS;
type Group = SettingsGroup;

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

type SettingsJump = { section: SettingsSection };

/** Run inside the visible Activity so its section is mounted before measuring. */
function SettingsJumpFeedback({ jump, bodyRef, finish }: {
  jump: SettingsJump | null;
  bodyRef: RefObject<HTMLDivElement | null>;
  finish: (value: null) => void;
}) {
  useEffect(() => {
    if (!jump) return;
    let target: HTMLElement | null = null;
    let timer: number | undefined;
    // Let WebKit finish the click and Activity reveal before moving focus.
    const start = window.setTimeout(() => {
      const body = bodyRef.current;
      target = body?.querySelector<HTMLElement>(`[data-settings-section="${jump.section.id}"]`) ?? null;
      if (!body || !target) return;
      // Flush the previous animation so choosing the same hit restarts it.
      target.classList.remove('settings-search-target');
      const top = target.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - 12;
      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      target.focus({ preventScroll: true });
      body.scrollTo({ top: Math.max(0, top), behavior: reducedMotion ? 'auto' : 'smooth' });
      target.classList.add('settings-search-target');
      timer = window.setTimeout(() => finish(null), 2200);
    }, 0);
    return () => {
      window.clearTimeout(start);
      window.clearTimeout(timer);
      target?.classList.remove('settings-search-target');
    };
  }, [jump, bodyRef, finish]);
  return null;
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
  const bodyRef = useRef<HTMLDivElement>(null);
  const [jump, setJump] = useState<SettingsJump | null>(null);

  useEffect(() => {
    if (!GROUPS.includes(openGroup as Group)) return;
    setGroup(openGroup as Group);
    setVisitedGroups((current) => new Set([...current, openGroup as Group]));
    setJump(null);
    onGroupOpened?.();
  }, [openGroup, onGroupOpened]);

  const choose = (next: Group) => {
    setGroup(next);
    setVisitedGroups((current) => new Set([...current, next]));
    window.localStorage?.setItem(STORAGE_KEY, next);
    setJump(null);
  };

  const jumpTo = (section: SettingsSection) => {
    choose(section.group);
    // A fresh request also restarts the feedback when choosing the same hit.
    setJump({ section });
  };

  const sections: Record<SettingsSectionId, ReactNode> = {
    listener: <ListenerSection />,
    upstream: <UpstreamSection />,
    'tls-trust': <TlsTrustSection />,
    'body-display': <BodyDisplaySection />,
    'match-replace': <MatchReplaceSection />,
    engine: <EngineSection />,
    capture: <CaptureSection />,
    tls: <TlsSection />,
    shortcuts: <ShortcutsSection />,
    browser: <BrowserSection />,
    ca: <CaSection onError={setError} />,
    'browser-help': <BrowserHelpSection />,
    appearance: <AppearanceSection />,
    language: <LanguageSection />,
    mcp: <McpSection />,
    lockdown: <LockdownSection />,
    project: <ProjectSection project={project} onSwitchProject={onSwitchProject}
      switchingProject={switchingProject} switchError={switchError}
      onProjectImported={() => {
        setImportRevision((revision) => revision + 1);
        onProjectImported?.();
      }} />,
    'media-storage': <CaptureStorageSection key={importRevision} />,
    compact: <ProjectCompactSection key={importRevision} />,
    about: <AboutSection />,
    updates: <UpdatesSection />,
  };

  return (
    <div className="settings-tab">
      <SettingsSearch onSelect={jumpTo} />
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

      <div className="settings-body" ref={bodyRef}>
        {GROUPS.filter((name) => visitedGroups.has(name)).map((name) =>
          <Activity key={name} mode={group === name ? 'visible' : 'hidden'}>
            <div className="settings-group">
              {SETTINGS_SECTIONS.filter((section) => section.group === name).map((section) =>
                <div key={section.id} className={`settings-section${jump?.section.id === section.id ? ' settings-search-target' : ''}`} data-settings-section={section.id}
                  role="region" aria-label={t(section.title)} tabIndex={-1}>
                  {sections[section.id]}
                </div>)}
            </div>
            <SettingsJumpFeedback jump={jump?.section.group === name ? jump : null} bodyRef={bodyRef} finish={setJump} />
          </Activity>)}
      </div>
    </div>
  );
}

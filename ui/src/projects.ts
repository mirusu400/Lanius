/** Desktop project commands. The shell chooses the data directory before the engine starts. */

export interface Project {
  id: string;
  name: string;
  temporary: boolean;
  dbPath: string;
  lastOpened: number;
}

function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const internals = (window as unknown as {
    __TAURI_INTERNALS__?: { invoke(cmd: string, args?: Record<string, unknown>): Promise<T> };
  }).__TAURI_INTERNALS__;
  if (!internals) return Promise.reject(new Error('Desktop shell is unavailable'));
  return internals.invoke(command, args);
}

export interface StartupDoctorCheck {
  id: string;
  status: 'ok' | 'warn' | 'error';
  detail: string;
  holder?: string | null;
  trace?: string;
}

/** The engine's preflight report, run by the shell before any project opens. */
export interface StartupDoctorReport {
  engine: string | null;
  report: { engine_version: string; platform: string; checks: StartupDoctorCheck[] } | null;
  error: string | null;
  output: string | null;
  last_log: string | null;
}

/** What a starting engine is doing; null when no project is starting. */
export interface StartupProgress {
  stage: 'launching' | 'database' | 'migrating' | 'engine' | 'proxy' | 'api' | string;
  version: number | null;
  target: number | null;
  elapsed_ms: number;
}

/** Prefix of the shell's refusal when a project needs a schema upgrade. */
export const MIGRATION_REQUIRED = 'LANIUS_MIGRATION_REQUIRED:';

export interface PendingMigration {
  current: number;
  target: number;
  size_bytes: number;
}

/** The upgrade a refused open is waiting for, or null for any other error. */
export function pendingMigration(error: unknown): PendingMigration | null {
  const text = error instanceof Error ? error.message : String(error);
  if (!text.startsWith(MIGRATION_REQUIRED)) return null;
  try {
    return JSON.parse(text.slice(MIGRATION_REQUIRED.length)) as PendingMigration;
  } catch {
    return null;
  }
}

export const listProjects = () => invoke<Project[]>('list_projects');
export const currentProject = () => invoke<Project | null>('current_project');
export const createProject = (name: string) => invoke<Project>('create_project', { name });
/**
 * Open a saved project. Without `allowMigration` the shell refuses one whose
 * database needs an upgrade, so the user can be asked first.
 */
export const openProject = (id: string, allowMigration = false) =>
  invoke<Project>('open_project', { id, allowMigration });
export const startTempProject = () => invoke<Project>('start_temp_project');
export const closeProject = () => invoke<void>('close_project');
export const runStartupDoctor = () => invoke<StartupDoctorReport>('run_doctor');
export const getStartupProgress = () => invoke<StartupProgress | null>('startup_progress');

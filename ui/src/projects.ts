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

export const listProjects = () => invoke<Project[]>('list_projects');
export const currentProject = () => invoke<Project | null>('current_project');
export const createProject = (name: string) => invoke<Project>('create_project', { name });
export const openProject = (id: string) => invoke<Project>('open_project', { id });
export const startTempProject = () => invoke<Project>('start_temp_project');
export const closeProject = () => invoke<void>('close_project');

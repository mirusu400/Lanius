/** Detection, confirmation text, and application of Lanius/Burp settings files. */

import {
  getLockdown,
  importProjectSettingsFile,
  restartProjectEngine,
  type ProjectImportResult,
} from './api/client';
import { notifyLockdownChanged } from './lockdownEvents';
import { resetUpdates } from './updates';
import { replaceWorkspace } from './tabs/autosave';
import type { Translator, TranslationKey } from './i18n';

const MAX_SETTINGS_FILE_BYTES = 16 * 1024 * 1024;
const BURP_ROOTS = ['logger', 'project_options', 'proxy', 'repeater', 'sequencer', 'target'] as const;

export interface SettingsImportCandidate {
  file: File;
  source: 'lanius' | 'burp';
  scope: number;
  matchReplace: number;
  listeners: number;
}

export class SettingsImportError extends Error {
  readonly key: TranslationKey;

  constructor(key: TranslationKey) {
    super(key);
    this.key = key;
  }
}

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

async function readFile(file: File): Promise<string> {
  if (file.size > MAX_SETTINGS_FILE_BYTES) throw new SettingsImportError('project.settingsFileTooLarge');
  if (typeof file.text === 'function') return file.text();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new SettingsImportError('project.settingsFileInvalid'));
    reader.readAsText(file);
  });
}

function jsonSettingCount(settings: JsonObject, key: string): number {
  const raw = settings[key];
  if (typeof raw !== 'string') return 0;
  try {
    return array(JSON.parse(raw)).length;
  } catch {
    return 0;
  }
}

function laniusListenerCount(settings: JsonObject): number {
  const raw = settings.proxy_listeners;
  if (typeof raw !== 'string') return 0;
  try {
    return array(object(JSON.parse(raw)).listeners).length;
  } catch {
    return 0;
  }
}

/** Parse only enough JSON to identify and summarize a settings import. */
export async function inspectSettingsFile(file: File): Promise<SettingsImportCandidate> {
  if (!file.name.toLowerCase().endsWith('.json') && file.type !== 'application/json') {
    throw new SettingsImportError('project.settingsFileJsonOnly');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file));
  } catch (error) {
    if (error instanceof SettingsImportError) throw error;
    throw new SettingsImportError('project.settingsFileInvalid');
  }
  const root = object(parsed);
  if (root.format === 'lanius-project') {
    if (root.version !== 1) throw new SettingsImportError('project.settingsFileVersion');
    if ('flows' in root) throw new SettingsImportError('project.settingsFileHasCapture');
    const settings = object(root.settings);
    return {
      file,
      source: 'lanius',
      scope: array(root.scope).length,
      matchReplace: jsonSettingCount(settings, 'match_replace_rules'),
      listeners: laniusListenerCount(settings),
    };
  }

  const burpRoots = BURP_ROOTS.filter((key) => key in root);
  if (burpRoots.length > 0 && burpRoots.every((key) => object(root[key]) === root[key])) {
    const target = object(root.target);
    const scope = object(target.scope);
    const proxy = object(root.proxy);
    const miscellaneous = object(proxy.miscellaneous);
    const projectOptions = object(root.project_options);
    const http2 = object(object(projectOptions.http).http2);
    const socks = object(object(projectOptions.connections).socks_proxy);
    const supported = 'scope' in target
      || 'match_replace_rules' in proxy
      || 'request_listeners' in proxy
      || typeof miscellaneous.disable_out_of_scope_logging_to_history_and_site_map === 'boolean'
      || miscellaneous.use_http_10_in_requests_to_server === true
      || typeof http2.enable_http2 === 'boolean'
      || typeof socks.use_proxy === 'boolean';
    if (!supported) throw new SettingsImportError('project.settingsFileUnsupported');
    return {
      file,
      source: 'burp',
      scope: array(scope.include).length + array(scope.exclude).length,
      matchReplace: array(proxy.match_replace_rules).length,
      listeners: array(proxy.request_listeners).filter((entry) => object(entry).running !== false).length,
    };
  }
  throw new SettingsImportError('project.settingsFileUnsupported');
}

export function settingsImportError(error: unknown, t: Translator): string {
  return t(error instanceof SettingsImportError ? error.key : 'project.settingsImportFailed', {
    message: error instanceof Error ? error.message : String(error),
  });
}

export function settingsSourceLabel(candidate: SettingsImportCandidate, t: Translator): string {
  return t(candidate.source === 'burp' ? 'project.settingsSourceBurp' : 'project.settingsSourceLanius');
}

export function settingsImportConfirmation(
  candidate: SettingsImportCandidate,
  t: Translator,
  projectName?: string,
): string {
  const values = {
    file: candidate.file.name,
    source: settingsSourceLabel(candidate, t),
    scope: candidate.scope,
    matchReplace: candidate.matchReplace,
    listeners: candidate.listeners,
    project: projectName ?? '',
  };
  if (projectName) return t('project.confirmSettingsImportLanding', values);
  return t(
    candidate.source === 'burp'
      ? 'project.confirmBurpSettingsImport'
      : 'project.confirmDetectedSettingsImport',
    values,
  );
}

/** Derive a readable, unique project name for a settings file dropped at startup. */
export function settingsProjectName(filename: string, existing: string[]): string {
  let base = filename
    .replace(/\.json$/i, '')
    .replace(/\.lanius$/i, '')
    .replace(/[_ -]+burp[_ -]+config$/i, '')
    .replace(/^lanius[_ -]+settings[_ -]*/i, '')
    .trim();
  if (!base) base = 'Imported settings';
  base = [...base].slice(0, 80).join('');
  const used = new Set(existing.map((name) => name.toLocaleLowerCase()));
  if (!used.has(base.toLocaleLowerCase())) return base;
  for (let index = 2; index < 10_000; index += 1) {
    const suffix = ` (${index})`;
    const stem = [...base].slice(0, 80 - suffix.length).join('');
    const candidate = `${stem}${suffix}`;
    if (!used.has(candidate.toLocaleLowerCase())) return candidate;
  }
  return [...`${base}-${Date.now()}`].slice(0, 80).join('');
}

export interface SettingsImportOutcome {
  result: ProjectImportResult;
  warning: string;
}

/** Apply through the same guarded project path used by the Settings screen. */
export async function applySettingsImport(file: File): Promise<SettingsImportOutcome> {
  const result = await replaceWorkspace(() => importProjectSettingsFile(file));
  let warning = result.warnings?.join('; ') ?? '';
  try {
    const lockdown = await getLockdown();
    if (lockdown.effective) resetUpdates();
    if (lockdown.project_enabled) await restartProjectEngine();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    warning = [warning, detail].filter(Boolean).join('; ');
  } finally {
    notifyLockdownChanged();
  }
  return { result, warning };
}

export function settingsImportSuccess(result: ProjectImportResult, t: Translator): string {
  if (result.source === 'burp') {
    return t('project.burpSettingsImported', {
      scope: result.scope ?? 0,
      matchReplace: result.match_replace ?? 0,
      listeners: result.listeners ?? 0,
      skipped: result.skipped ?? 0,
    });
  }
  return t('project.settingsImported', {
    scope: result.scope ?? 0,
    workspace: result.workspace ?? 0,
  });
}

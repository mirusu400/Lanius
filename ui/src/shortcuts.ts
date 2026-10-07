/** User-configurable keyboard shortcuts shared by shortcut handlers and Settings. */

import type { TranslationKey } from './i18n/catalogue';

export interface KeyboardShortcut {
  code: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export interface ShortcutDefinition {
  id: string;
  category: 'general' | 'navigation' | 'replay';
  label: TranslationKey;
  description?: TranslationKey;
  defaults: Record<ShortcutPlatform, KeyboardShortcut | null>;
}

export type ShortcutPlatform = 'mac' | 'windows' | 'linux';

const STORAGE_KEY = 'lanius.shortcuts.v1';
let memoryOverrides: Record<string, KeyboardShortcut | null> | null = null;

const shortcut = (
  code: string,
  modifiers: Partial<Omit<KeyboardShortcut, 'code'>> = {},
): KeyboardShortcut => ({
  code,
  ctrl: modifiers.ctrl ?? false,
  alt: modifiers.alt ?? false,
  shift: modifiers.shift ?? false,
  meta: modifiers.meta ?? false,
});

function defaultFor(
  code: string,
  extra: Partial<Omit<KeyboardShortcut, 'code'>> = {},
): Record<ShortcutPlatform, KeyboardShortcut> {
  return {
    mac: shortcut(code, { ...extra, meta: true }),
    windows: shortcut(code, { ...extra, ctrl: true }),
    linux: shortcut(code, { ...extra, ctrl: true }),
  };
}

const navigation = [
  ['dashboard', 'shortcuts.openDashboard', 'Digit0'],
  ['proxy', 'shortcuts.openProxy', 'Digit1'],
  ['target', 'shortcuts.openTarget', 'Digit2'],
  ['replay', 'shortcuts.openReplay', 'Digit3'],
  ['fuzzer', 'shortcuts.openFuzzer', 'Digit4'],
  ['decoder', 'shortcuts.openDecoder', 'Digit5'],
  ['diff', 'shortcuts.openDiff', 'Digit6'],
  ['logger', 'shortcuts.openLogger', 'Digit7'],
  ['plugins', 'shortcuts.openPlugins', 'Digit8'],
  ['settings', 'shortcuts.openSettings', 'Digit9'],
  ['docs', 'shortcuts.openDocs', 'KeyD'],
] as const satisfies readonly (readonly [string, TranslationKey, string])[];

/** Every shortcut with a handler is listed here and appears in Settings. */
export const SHORTCUTS: ShortcutDefinition[] = [
  {
    id: 'request.sendToReplay',
    category: 'general',
    label: 'menu.sendToReplay',
    description: 'shortcuts.sendToReplayHelp',
    defaults: defaultFor('KeyR'),
  },
  {
    id: 'request.sendToFuzzer',
    category: 'general',
    label: 'menu.sendToFuzzer',
    description: 'shortcuts.sendToFuzzerHelp',
    defaults: defaultFor('KeyI'),
  },
  {
    id: 'app.screenshot',
    category: 'general',
    label: 'shortcuts.captureWindow',
    description: 'shortcuts.captureWindowHelp',
    defaults: {
      mac: shortcut('KeyS', { meta: true, ctrl: true, shift: true }),
      windows: null,
      linux: null,
    },
  },
  ...navigation.map(([name, label, code]): ShortcutDefinition => ({
    id: `app.${name}`,
    category: 'navigation',
    label,
    defaults: defaultFor(code, { alt: true }),
  })),
  {
    id: 'replay.send',
    category: 'replay',
    label: 'shortcuts.replaySend',
    description: 'shortcuts.replaySendHelp',
    defaults: defaultFor('Enter'),
  },
  {
    id: 'replay.new',
    category: 'replay',
    label: 'shortcuts.replayNew',
    defaults: defaultFor('KeyN', { alt: true }),
  },
  {
    id: 'replay.duplicate',
    category: 'replay',
    label: 'shortcuts.replayDuplicate',
    defaults: defaultFor('KeyU', { alt: true }),
  },
  {
    id: 'replay.close',
    category: 'replay',
    label: 'shortcuts.replayClose',
    defaults: defaultFor('KeyX', { alt: true }),
  },
  {
    id: 'replay.previous',
    category: 'replay',
    label: 'shortcuts.replayPrevious',
    defaults: defaultFor('BracketLeft', { alt: true }),
  },
  {
    id: 'replay.next',
    category: 'replay',
    label: 'shortcuts.replayNext',
    defaults: defaultFor('BracketRight', { alt: true }),
  },
];

export function currentPlatform(): ShortcutPlatform {
  if (typeof navigator === 'undefined') return 'windows';
  const extendedNavigator = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  const platform = extendedNavigator.userAgentData?.platform ?? navigator.platform ?? '';
  if (/mac|iphone|ipad|ipod/i.test(platform)) return 'mac';
  if (/win/i.test(platform)) return 'windows';
  return 'linux';
}

function validShortcut(value: unknown): value is KeyboardShortcut {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<KeyboardShortcut>;
  return (
    typeof candidate.code === 'string' &&
    /^[A-Za-z][A-Za-z0-9]*$/.test(candidate.code) &&
    typeof candidate.ctrl === 'boolean' &&
    typeof candidate.alt === 'boolean' &&
    typeof candidate.shift === 'boolean' &&
    typeof candidate.meta === 'boolean' &&
    (candidate.ctrl || candidate.alt || candidate.meta)
  );
}

function readOverrides(): Record<string, KeyboardShortcut | null> {
  if (memoryOverrides) return { ...memoryOverrides };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      memoryOverrides = {};
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      memoryOverrides = {};
      return {};
    }
    const result: Record<string, KeyboardShortcut | null> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (value === null || validShortcut(value)) result[id] = value;
    }
    memoryOverrides = result;
    return result;
  } catch {
    memoryOverrides = {};
    return {};
  }
}

export function getShortcut(id: string): KeyboardShortcut | null {
  const overrides = readOverrides();
  if (Object.hasOwn(overrides, id)) return overrides[id];
  const definition = SHORTCUTS.find((entry) => entry.id === id);
  return definition?.defaults[currentPlatform()] ?? null;
}

export function saveShortcut(id: string, value: KeyboardShortcut | null): void {
  const overrides = readOverrides();
  const definition = SHORTCUTS.find((entry) => entry.id === id);
  if (!definition) return;

  const defaultValue = definition.defaults[currentPlatform()];
  if (sameShortcut(value, defaultValue)) delete overrides[id];
  else overrides[id] = value;
  memoryOverrides = overrides;

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // The shortcut still works for this session if browser storage is full
    // or disabled; it will simply not persist after a reload.
  }
}

export function resetShortcut(id: string): void {
  const overrides = readOverrides();
  delete overrides[id];
  memoryOverrides = overrides;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // See saveShortcut: settings remain usable for the current session.
  }
}

export function sameShortcut(
  left: KeyboardShortcut | null,
  right: KeyboardShortcut | null,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.code === right.code &&
    left.ctrl === right.ctrl &&
    left.alt === right.alt &&
    left.shift === right.shift &&
    left.meta === right.meta
  );
}

export function shortcutFromEvent(event: KeyboardEvent): KeyboardShortcut | null {
  if (
    event.getModifierState('AltGraph') ||
    event.code === 'Unidentified' ||
    event.code === 'ShiftLeft' || event.code === 'ShiftRight' ||
    event.code === 'ControlLeft' || event.code === 'ControlRight' ||
    event.code === 'AltLeft' || event.code === 'AltRight' ||
    event.code === 'MetaLeft' || event.code === 'MetaRight' ||
    event.code === 'Escape'
  ) return null;

  const candidate: KeyboardShortcut = {
    code: event.code,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
  };
  return validShortcut(candidate) ? candidate : null;
}

export function matchesShortcut(
  event: KeyboardEvent,
  binding: KeyboardShortcut | null,
): boolean {
  return Boolean(
    binding &&
    !event.getModifierState('AltGraph') &&
    event.code === binding.code &&
    event.ctrlKey === binding.ctrl &&
    event.altKey === binding.alt &&
    event.shiftKey === binding.shift &&
    event.metaKey === binding.meta,
  );
}

export function formatShortcut(
  binding: KeyboardShortcut | null,
  platform = currentPlatform(),
): string {
  if (!binding) return '—';
  const key = keyLabel(binding.code);
  if (platform === 'mac') {
    return [
      binding.ctrl ? '⌃' : '',
      binding.alt ? '⌥' : '',
      binding.shift ? '⇧' : '',
      binding.meta ? '⌘' : '',
      key,
    ].filter(Boolean).join('');
  }
  return [
    binding.ctrl ? 'Ctrl' : '',
    binding.alt ? 'Alt' : '',
    binding.shift ? 'Shift' : '',
    binding.meta ? 'Meta' : '',
    key,
  ].filter(Boolean).join('+');
}

function keyLabel(code: string): string {
  if (code === 'Space') return 'Space';
  if (code === 'Enter') return 'Enter';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  if (code.startsWith('Arrow')) return code.slice(5);
  if (code.startsWith('F') && /^F\d+$/.test(code)) return code;
  const labels: Record<string, string> = {
    Backquote: '`',
    Backslash: '\\',
    BracketLeft: '[',
    BracketRight: ']',
    Comma: ',',
    Equal: '=',
    Minus: '-',
    Period: '.',
    Quote: "'",
    Semicolon: ';',
    Slash: '/',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Tab: 'Tab',
  };
  return labels[code] ?? code;
}

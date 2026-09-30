export const DEFAULT_TAB_ORDER = [
  'Dashboard',
  'Issues',
  'Proxy',
  'Target',
  'Replay',
  'Fuzzer',
  'Decoder',
  'Diff',
  'Logger',
  'Plugins',
  'Settings',
  'Docs',
] as const;

export type Tab = (typeof DEFAULT_TAB_ORDER)[number];
export type DropSide = 'before' | 'after';

export const TAB_ORDER_STORAGE_KEY = 'lanius.tabOrder.v1';

const KNOWN_TABS = new Set<string>(DEFAULT_TAB_ORDER);

function isTab(value: unknown): value is Tab {
  return typeof value === 'string' && KNOWN_TABS.has(value);
}

/** Restore a complete, duplicate-free order and tolerate older saved layouts. */
export function loadTabOrder(storage: Pick<Storage, 'getItem'> = window.localStorage): Tab[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(TAB_ORDER_STORAGE_KEY) ?? 'null');
    if (!Array.isArray(parsed)) return [...DEFAULT_TAB_ORDER];

    const saved = parsed.filter(isTab);
    const unique = saved.filter((tab, index) => saved.indexOf(tab) === index);
    return [
      ...unique,
      ...DEFAULT_TAB_ORDER.filter((tab) => !unique.includes(tab)),
    ];
  } catch {
    return [...DEFAULT_TAB_ORDER];
  }
}

export function saveTabOrder(
  order: readonly Tab[],
  storage: Pick<Storage, 'setItem'> = window.localStorage,
): void {
  try {
    storage.setItem(TAB_ORDER_STORAGE_KEY, JSON.stringify(order));
  } catch {
    // Reordering still works for this session when browser storage is disabled.
  }
}

export function moveTab(
  order: readonly Tab[],
  source: Tab,
  target: Tab,
  side: DropSide,
): Tab[] {
  if (source === target || !order.includes(source) || !order.includes(target)) {
    return [...order];
  }

  const next = order.filter((tab) => tab !== source);
  const targetIndex = next.indexOf(target);
  next.splice(targetIndex + (side === 'after' ? 1 : 0), 0, source);
  return next;
}

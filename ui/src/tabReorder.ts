export type TabDropSide = 'before' | 'after';

/** Move one stable-id tab around another without changing either tab. */
export function reorderTabs<T extends { id: string }>(
  tabs: T[],
  sourceId: string,
  targetId: string,
  side: TabDropSide,
): T[] {
  if (sourceId === targetId) return tabs;
  const sourceIndex = tabs.findIndex((tab) => tab.id === sourceId);
  const targetIndex = tabs.findIndex((tab) => tab.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0) return tabs;

  const next = [...tabs];
  const [source] = next.splice(sourceIndex, 1);
  const adjustedTargetIndex = next.findIndex((tab) => tab.id === targetId);
  next.splice(adjustedTargetIndex + (side === 'after' ? 1 : 0), 0, source);

  return next.every((tab, index) => tab === tabs[index]) ? tabs : next;
}

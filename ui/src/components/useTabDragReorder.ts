import { useRef, useState, type DragEvent } from 'react';

import type { TabDropSide } from '../tabReorder';

interface DropTarget {
  id: string;
  side: TabDropSide;
}

/** Shared native drag state for reorderable Replay/Fuzzer tab strips. */
export function useTabDragReorder(
  move: (sourceId: string, targetId: string, side: TabDropSide) => void,
) {
  const sourceRef = useRef<string | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  const finish = () => {
    sourceRef.current = null;
    setDraggedId(null);
    setDropTarget(null);
  };

  const start = (event: DragEvent<HTMLButtonElement>, id: string) => {
    sourceRef.current = id;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', id);
    setDraggedId(id);
  };

  const sideAt = (event: DragEvent<HTMLDivElement>): TabDropSide => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return event.clientX < bounds.left + bounds.width / 2 ? 'before' : 'after';
  };

  const over = (event: DragEvent<HTMLDivElement>, id: string) => {
    const sourceId = sourceRef.current;
    if (!sourceId || sourceId === id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropTarget({ id, side: sideAt(event) });
  };

  const drop = (event: DragEvent<HTMLDivElement>, id: string) => {
    const sourceId = sourceRef.current;
    if (!sourceId || sourceId === id) {
      finish();
      return;
    }
    event.preventDefault();
    move(sourceId, id, sideAt(event));
    finish();
  };

  return { draggedId, dropTarget, start, over, drop, finish };
}

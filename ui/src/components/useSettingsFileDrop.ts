import { useEffect, useState } from 'react';

function carriesFiles(transfer: DataTransfer | null): boolean {
  return Boolean(transfer?.types && Array.from(transfer.types).includes('Files'));
}

/** Window-wide file drop handling that leaves ordinary in-app tab drags alone. */
export function useSettingsFileDrop(onFile: (file: File) => void, disabled = false): boolean {
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (disabled) return;
    let depth = 0;
    const enter = (event: DragEvent) => {
      if (!carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      depth += 1;
      setActive(true);
    };
    const over = (event: DragEvent) => {
      if (!carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      setActive(true);
    };
    const leave = (event: DragEvent) => {
      if (!carriesFiles(event.dataTransfer)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setActive(false);
    };
    const drop = (event: DragEvent) => {
      if (!carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      depth = 0;
      setActive(false);
      const file = event.dataTransfer?.files?.[0];
      if (file) onFile(file);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [disabled, onFile]);

  return active && !disabled;
}

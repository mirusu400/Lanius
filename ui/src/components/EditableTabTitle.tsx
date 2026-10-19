import { useState, type MouseEvent as ReactMouseEvent } from 'react';

import './EditableTabTitle.css';

interface EditableTabTitleProps {
  active: boolean;
  ariaLabel: string;
  buttonClassName: string;
  displayTitle: string;
  editValue?: string;
  tooltip?: string;
  onContextMenu?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onRename: (title: string) => void;
  onSelect: () => void;
}

/** A tab selector that turns into a text field when its title is double-clicked. */
export function EditableTabTitle({
  active,
  ariaLabel,
  buttonClassName,
  displayTitle,
  editValue = displayTitle,
  tooltip = displayTitle,
  onContextMenu,
  onRename,
  onSelect,
}: EditableTabTitleProps) {
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    if (draft === null) return;
    const title = draft.trim();
    setDraft(null);
    if (title && title !== editValue) onRename(title);
  };

  if (draft !== null) {
    return (
      <input
        className="tab-title-input"
        aria-label={ariaLabel}
        autoFocus
        value={draft}
        onBlur={commit}
        onChange={(event) => setDraft(event.target.value)}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            setDraft(null);
          }
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className={`${buttonClassName}${active ? ' active' : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      onDoubleClick={(event) => {
        event.stopPropagation();
        setDraft(editValue);
      }}
    >
      <span className="tab-title" title={tooltip}>{displayTitle}</span>
    </button>
  );
}

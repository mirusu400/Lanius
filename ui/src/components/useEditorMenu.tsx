/** Context menu for the request editors in Repeater and Intruder.
 *
 * Without one, right-clicking the body fell through to the webview's own
 * text menu, which knows nothing about the request being edited. This
 * offers the editing actions plus the moves between tools that are the
 * reason to right-click a request in the first place.
 */
import { useRef, useState, type RefObject } from 'react';

import { ContextMenu, useContextMenu, type MenuItem } from './ContextMenu';
import { useT } from '../i18n';

export interface EditorMenuExtra {
  label: string;
  onSelect: (selection: string, editor: HTMLTextAreaElement) => void;
  /** Hidden when nothing is selected, for actions that need a selection. */
  needsSelection?: boolean;
}

/** Wire a textarea up to an application menu instead of the native one. */
export function useEditorMenu(extras: EditorMenuExtra[] = []) {
  const t = useT();
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const menu = useContextMenu<null>();
  // Captured on open: clicking a menu item moves focus, which would
  // otherwise collapse the selection before the action runs.
  const [selection, setSelection] = useState({ start: 0, end: 0, text: '' });

  const open = (event: React.MouseEvent) => {
    const editor = ref.current;
    if (editor) {
      setSelection({
        start: editor.selectionStart,
        end: editor.selectionEnd,
        text: editor.value.slice(editor.selectionStart, editor.selectionEnd),
      });
    }
    menu.open(event, null);
  };

  const hasSelection = selection.end > selection.start;

  const withEditor = (run: (editor: HTMLTextAreaElement) => void) => () => {
    const editor = ref.current;
    if (editor) run(editor);
  };

  const items: MenuItem[] = [
    {
      label: t('editor.copy'),
      disabled: !hasSelection,
      onSelect: () => void navigator.clipboard?.writeText(selection.text),
    },
    {
      label: t('editor.cut'),
      disabled: !hasSelection,
      onSelect: withEditor((editor) => {
        void navigator.clipboard?.writeText(selection.text);
        setNativeValue(
          editor,
          editor.value.slice(0, selection.start) + editor.value.slice(selection.end),
        );
      }),
    },
    {
      label: t('editor.paste'),
      onSelect: withEditor(async (editor) => {
        const text = await navigator.clipboard?.readText();
        if (typeof text !== 'string') return;
        setNativeValue(
          editor,
          editor.value.slice(0, selection.start) +
            text +
            editor.value.slice(selection.end),
        );
      }),
    },
    {
      label: t('editor.selectAll'),
      onSelect: withEditor((editor) => {
        editor.focus();
        editor.select();
      }),
    },
    ...extras
      .filter((extra) => !extra.needsSelection || hasSelection)
      .map((extra) => ({
        label: extra.label,
        onSelect: withEditor((editor) => extra.onSelect(selection.text, editor)),
      })),
  ];

  const element = (
    <ContextMenu position={menu.position} items={items} onClose={menu.close} />
  );

  return { ref, open, element, selection };
}

/** Set a controlled textarea's value so React sees the change.
 *
 * Assigning `.value` directly updates the DOM but not React's state, so
 * the edit would be reverted on the next render.
 */
function setNativeValue(editor: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  setter?.call(editor, value);
  editor.dispatchEvent(new Event('input', { bubbles: true }));
}

export type EditorMenu = ReturnType<typeof useEditorMenu>;
export type EditorRef = RefObject<HTMLTextAreaElement | null>;

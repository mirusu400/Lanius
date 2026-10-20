/** State shared by the views that host the Inspector. */

import { useCallback, useEffect, useState } from 'react';
import { DOCUMENT_SELECTION_EVENT, documentSelection } from './textDocument';

export interface InspectorSelection {
  text: string;
  /** Offsets in the editor, when the selection is in one. */
  start?: number;
  end?: number;
}

const OPEN_KEY = 'lanius.inspector.open';

/** Whether the panel is shown, remembered across tabs and restarts. */
export function useInspectorOpen(): [boolean, () => void] {
  const [open, setOpen] = useState(() => window.localStorage?.getItem(OPEN_KEY) !== '0');
  const toggle = useCallback(() => {
    setOpen((current) => {
      window.localStorage?.setItem(OPEN_KEY, current ? '0' : '1');
      return !current;
    });
  }, []);
  return [open, toggle];
}

/** Follow the selection inside `container`.
 *
 * A textarea's selection is not part of the document selection, so the
 * editor is read separately. A selection elsewhere, or one collapsed to a
 * caret, leaves the last one in place: clicking into the panel to edit
 * must not clear what it is showing.
 *
 * `scope` names the document being shown (a flow, a Replay tab). A
 * selection made in one is not carried over to the next.
 */
export function useInspectorSelection(
  container: React.RefObject<HTMLElement | null>,
  scope: string | null,
  editor?: React.RefObject<HTMLTextAreaElement | null>,
): [InspectorSelection | null, (selection: InspectorSelection | null) => void] {
  const [state, setState] = useState<{ scope: string | null; selection: InspectorSelection | null }>({
    scope,
    selection: null,
  });

  const set = useCallback(
    (selection: InspectorSelection | null) => setState({ scope, selection }),
    [scope],
  );

  useEffect(() => {
    const keep = (next: InspectorSelection) =>
      setState((current) => {
        const previous = current.scope === scope ? current.selection : null;
        if (previous?.text === next.text && previous.start === next.start) return current;
        return { scope, selection: next };
      });
    const update = () => {
      const root = container.current;
      const virtual = root && documentSelection(root);
      if (virtual) {
        if (virtual.text) keep({ text: virtual.text });
        return;
      }
      const area = editor?.current;
      if (area && document.activeElement === area) {
        const { selectionStart: start, selectionEnd: end } = area;
        if (end > start) keep({ text: area.value.slice(start, end), start, end });
        return;
      }
      const range = window.getSelection();
      if (!range || range.isCollapsed || !root) return;
      if (!range.anchorNode || !range.focusNode) return;
      if (!root.contains(range.anchorNode) || !root.contains(range.focusNode)) return;
      const text = range.toString();
      if (text) keep({ text });
    };
    // WebKit does not always report selection changes inside a textarea,
    // so the end of a drag or a shift-arrow is checked too. On the
    // document, because the container may not exist yet.
    const events = ['selectionchange', 'mouseup', 'keyup', DOCUMENT_SELECTION_EVENT] as const;
    for (const name of events) document.addEventListener(name, update);
    return () => {
      for (const name of events) document.removeEventListener(name, update);
    };
  }, [container, editor, scope]);

  return [state.scope === scope ? state.selection : null, set];
}

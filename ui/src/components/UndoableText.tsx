/** Controlled text controls with an application-owned undo history.
 *
 * WebView undo is not reliable once React writes a controlled value back to
 * the DOM. These controls keep bounded histories and handle the platform undo
 * shortcuts themselves. A history key separates documents rendered through
 * the same component instance.
 */
import { useLayoutEffect, useRef } from 'react';

const HISTORY_LIMIT = 100;
const DOCUMENT_LIMIT = 32;
const DEFAULT_HISTORY_KEY = Symbol('default-text-history');

type TextControl = HTMLInputElement | HTMLTextAreaElement;
type HistoryKey = string | symbol;

interface EditorSnapshot {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

interface EditorHistory {
  current: EditorSnapshot;
  undo: EditorSnapshot[];
  redo: EditorSnapshot[];
  lastEdit: {
    kind: string;
    at: number;
    selectionStart: number;
    selectionEnd: number;
  } | null;
}

function newHistory(value: string): EditorHistory {
  return {
    current: { value, selectionStart: 0, selectionEnd: 0 },
    undo: [],
    redo: [],
    lastEdit: null,
  };
}

function pushSnapshot(stack: EditorSnapshot[], snapshot: EditorSnapshot): void {
  stack.push(snapshot);
  if (stack.length > HISTORY_LIMIT) stack.splice(0, stack.length - HISTORY_LIMIT);
}

function editKind(inputType: string): string | null {
  if (inputType === 'insertText' || inputType === 'insertCompositionText') return 'insert';
  if (inputType === 'deleteContentBackward') return 'delete-backward';
  if (inputType === 'deleteContentForward') return 'delete-forward';
  return null;
}

function domValue(value: string): string {
  // textarea.value exposes all newlines as LF even if the controlled value
  // preserves captured HTTP CRLF bytes.
  return value.replace(/\r\n?/g, '\n');
}

function getHistory(
  histories: Map<HistoryKey, EditorHistory>,
  key: HistoryKey,
  value: string,
): EditorHistory {
  const existing = histories.get(key);
  if (existing) return existing;
  while (histories.size >= DOCUMENT_LIMIT) {
    const oldest = histories.keys().next().value as HistoryKey | undefined;
    if (oldest === undefined) break;
    histories.delete(oldest);
  }
  const created = newHistory(value);
  histories.set(key, created);
  return created;
}

function selection(control: TextControl): [number, number] {
  const end = control.value.length;
  return [control.selectionStart ?? end, control.selectionEnd ?? end];
}

function useUndoableText<T extends TextControl>(
  value: string,
  onValueChange: (value: string) => void,
  historyKey: string | undefined,
  controlRef: React.RefObject<T | null>,
  locked: boolean,
) {
  const key = historyKey ?? DEFAULT_HISTORY_KEY;
  const historiesRef = useRef(
    new Map<HistoryKey, EditorHistory>([[key, newHistory(value)]]),
  );
  const pendingSelectionRef = useRef<{
    key: HistoryKey;
    snapshot: EditorSnapshot;
  } | null>(null);

  useLayoutEffect(() => {
    const history = getHistory(historiesRef.current, key, value);
    if (history.current.value === value) return;

    // Buttons, context menus and asynchronous loaders can change a controlled
    // value without producing an input event. Keep those changes undoable too.
    pushSnapshot(history.undo, history.current);
    history.current = {
      value,
      selectionStart: Math.min(history.current.selectionStart, value.length),
      selectionEnd: Math.min(history.current.selectionEnd, value.length),
    };
    history.redo = [];
    history.lastEdit = null;
  }, [key, value]);

  useLayoutEffect(() => {
    const pending = pendingSelectionRef.current;
    const control = controlRef.current;
    if (!pending || pending.key !== key || pending.snapshot.value !== value || !control) {
      return;
    }
    try {
      control.setSelectionRange(
        pending.snapshot.selectionStart,
        pending.snapshot.selectionEnd,
      );
    } catch {
      // Some input types do not expose a selection. Text controls do, but
      // keeping this defensive makes the shared primitive safe to reuse.
    }
    pendingSelectionRef.current = null;
  }, [controlRef, key, value]);

  const commit = (event: React.ChangeEvent<T>) => {
    const control = event.currentTarget;
    const next = control.value;
    const history = getHistory(historiesRef.current, key, value);
    if (next === history.current.value) return;

    const [selectionStart, selectionEnd] = selection(control);
    const inputType = (event.nativeEvent as InputEvent).inputType ?? '';
    const now = Date.now();
    const kind = editKind(inputType);
    const coalesces = Boolean(
      kind &&
      history.lastEdit?.kind === kind &&
      now - history.lastEdit.at < 1_000 &&
      history.current.selectionStart === history.lastEdit.selectionStart &&
      history.current.selectionEnd === history.lastEdit.selectionEnd,
    );
    if (!coalesces) pushSnapshot(history.undo, history.current);
    history.current = { value: next, selectionStart, selectionEnd };
    history.redo = [];
    history.lastEdit = kind
      ? { kind, at: now, selectionStart, selectionEnd }
      : null;
    onValueChange(next);
  };

  const keyDown = (event: React.KeyboardEvent<T>): boolean => {
    if (locked || !(event.ctrlKey || event.metaKey) || event.altKey) return false;
    const pressed = event.key.toLowerCase();
    const direction = pressed === 'z' && !event.shiftKey
      ? 'undo'
      : pressed === 'y' || (pressed === 'z' && event.shiftKey)
        ? 'redo'
        : null;
    if (!direction) return false;

    event.preventDefault();
    event.stopPropagation();
    const history = getHistory(historiesRef.current, key, value);
    const from = direction === 'undo' ? history.undo : history.redo;
    const to = direction === 'undo' ? history.redo : history.undo;
    const next = from.pop();
    if (!next) return true;
    pushSnapshot(to, history.current);
    history.current = next;
    history.lastEdit = null;
    pendingSelectionRef.current = { key, snapshot: next };
    onValueChange(next.value);
    return true;
  };

  const rememberSelection = (event: React.SyntheticEvent<T>) => {
    const control = event.currentTarget;
    const history = getHistory(historiesRef.current, key, value);
    if (control.value !== domValue(history.current.value)) return;
    const [selectionStart, selectionEnd] = selection(control);
    history.current = { ...history.current, selectionStart, selectionEnd };
  };

  return { commit, keyDown, rememberSelection };
}

export type UndoableTextareaProps = Omit<
  React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  'defaultValue' | 'onChange' | 'value'
> & {
  value: string;
  onValueChange: (value: string) => void;
  historyKey?: string;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
};

export function UndoableTextarea({
  value,
  onValueChange,
  historyKey,
  textareaRef: providedRef,
  onKeyDown,
  onSelect,
  onKeyUp,
  onMouseUp,
  readOnly,
  disabled,
  ...props
}: UndoableTextareaProps) {
  const localRef = useRef<HTMLTextAreaElement | null>(null);
  const textareaRef = providedRef ?? localRef;
  const history = useUndoableText(
    value,
    onValueChange,
    historyKey,
    textareaRef,
    Boolean(readOnly || disabled),
  );

  return <textarea
    {...props}
    ref={textareaRef}
    value={value}
    readOnly={readOnly}
    disabled={disabled}
    onChange={history.commit}
    onKeyDown={(event) => {
      if (!history.keyDown(event)) onKeyDown?.(event);
    }}
    onSelect={(event) => {
      history.rememberSelection(event);
      onSelect?.(event);
    }}
    onKeyUp={(event) => {
      history.rememberSelection(event);
      onKeyUp?.(event);
    }}
    onMouseUp={(event) => {
      history.rememberSelection(event);
      onMouseUp?.(event);
    }}
  />;
}

export type UndoableInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'defaultValue' | 'onChange' | 'value'
> & {
  value: string;
  onValueChange: (value: string) => void;
  historyKey?: string;
  inputRef?: React.RefObject<HTMLInputElement | null>;
};

export function UndoableInput({
  value,
  onValueChange,
  historyKey,
  inputRef: providedRef,
  onKeyDown,
  onSelect,
  onKeyUp,
  onMouseUp,
  readOnly,
  disabled,
  ...props
}: UndoableInputProps) {
  const localRef = useRef<HTMLInputElement | null>(null);
  const inputRef = providedRef ?? localRef;
  const history = useUndoableText(
    value,
    onValueChange,
    historyKey,
    inputRef,
    Boolean(readOnly || disabled),
  );

  return <input
    {...props}
    ref={inputRef}
    value={value}
    readOnly={readOnly}
    disabled={disabled}
    onChange={history.commit}
    onKeyDown={(event) => {
      if (!history.keyDown(event)) onKeyDown?.(event);
    }}
    onSelect={(event) => {
      history.rememberSelection(event);
      onSelect?.(event);
    }}
    onKeyUp={(event) => {
      history.rememberSelection(event);
      onKeyUp?.(event);
    }}
    onMouseUp={(event) => {
      history.rememberSelection(event);
      onMouseUp?.(event);
    }}
  />;
}

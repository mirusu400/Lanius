import type { KeyboardEvent, PointerEvent } from 'react';

import { selectAllTextDocument } from './textDocument';

const NATIVE_SELECTION = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
const SELECTABLE = '[data-select-all], [data-text-document]';

/** Handle both focused text and shortcuts issued from its view controls. */
export function selectAllText(event: KeyboardEvent<HTMLElement>): void {
  if (event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey
    || (event.code !== 'KeyA' && event.key.toLowerCase() !== 'a')) return;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest(NATIVE_SELECTION)) return;

  const root = event.currentTarget;
  const focused = target?.closest<HTMLElement>(SELECTABLE);
  const content = focused && root.contains(focused) ? focused
    : root.matches(SELECTABLE) ? root : root.querySelector<HTMLElement>(SELECTABLE);
  if (!content) return;
  if (selectAllTextDocument(content)) {
    event.preventDefault();
    return;
  }

  const selection = content.ownerDocument.getSelection();
  if (!selection) return;
  event.preventDefault();
  content.focus({ preventScroll: true });
  const range = content.ownerDocument.createRange();
  range.selectNodeContents(content);
  selection.removeAllRanges();
  selection.addRange(range);
}

function focusText(event: PointerEvent<HTMLElement>): void {
  if (event.button !== 0) return;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest(`${NATIVE_SELECTION}, button, a, iframe`)) return;
  event.currentTarget.focus({ preventScroll: true });
}

export const selectableTextProps = {
  'data-select-all': '',
  tabIndex: 0,
  onPointerDown: focusText,
  onKeyDown: selectAllText,
};

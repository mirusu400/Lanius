/** Selection in a virtual text view belongs to its document, not its DOM. */
export interface DocumentSelection { text: string; start: number; end: number }

export const DOCUMENT_SELECTION_EVENT = 'lanius:document-selection';
const readers = new WeakMap<Element, () => DocumentSelection>();

export function registerTextDocument(element: HTMLElement, read: () => DocumentSelection): () => void {
  element.dataset.textDocument = '';
  readers.set(element, read);
  return () => { readers.delete(element); delete element.dataset.textDocument; };
}

export function documentSelection(root: Element, target: EventTarget | null = document.activeElement): DocumentSelection | null {
  const element = target instanceof Element ? target.closest('[data-text-document]') : null;
  return element && root.contains(element) ? readers.get(element)?.() ?? null : null;
}

export function selectedText(root: Element, target?: EventTarget | null): string {
  const virtual = documentSelection(root, target);
  if (virtual) return virtual.text;
  const selection = window.getSelection();
  return selection && !selection.isCollapsed && selection.anchorNode && selection.focusNode
    && root.contains(selection.anchorNode) && root.contains(selection.focusNode)
    ? selection.toString() : '';
}

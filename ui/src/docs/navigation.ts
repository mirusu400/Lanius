/** In-app guide navigation, including requests from notification actions.
 * The selected page survives workspace remounts, as it did before links to
 * the guide could be opened from elsewhere. */
export const OPEN_DOCS_PAGE = 'lanius.openDocsPage';

let selectedPage = 'wiki:features';

export function currentDocsPage(): string {
  return selectedPage;
}

export function rememberDocsPage(page: string): void {
  selectedPage = page;
}

export function openDocsPage(page: string): void {
  selectedPage = page;
  window.dispatchEvent(new Event(OPEN_DOCS_PAGE));
}

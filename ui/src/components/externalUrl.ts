/** Only web URLs are handed to the operating system.
 *
 * Keeping this check in the UI as well as the Tauri capability prevents a
 * relative documentation link or a future custom protocol from accidentally
 * becoming an OS launch request.
 */
export function isExternalWebUrl(href: string | undefined): href is string {
  if (!href) return false;
  try {
    const protocol = new URL(href).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** Native shutdown handshake; the engine stays alive until the UI has saved. */
export const CLOSE_REQUESTED = 'lanius-close-requested';

export function desktopCloseCommand(command: 'close_ready' | 'finish_close' | 'cancel_close'): Promise<void> {
  const internals = (window as unknown as {
    __TAURI_INTERNALS__: { invoke(cmd: string): Promise<void> };
  }).__TAURI_INTERNALS__;
  return internals.invoke(command);
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  readText: vi.fn<() => Promise<string>>(),
  writeText: vi.fn<(text: string) => Promise<void>>(),
}));

vi.mock('@tauri-apps/plugin-clipboard-manager', () => native);

import {
  copyTextToClipboard,
  readClipboardText,
  subscribeClipboardErrors,
  writeClipboardText,
} from './clipboard';

describe('clipboard', () => {
  let clipboardDescriptor: PropertyDescriptor | undefined;
  let tauriDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    native.readText.mockResolvedValue('native paste');
    native.writeText.mockResolvedValue(undefined);
    clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    tauriDescriptor = Object.getOwnPropertyDescriptor(window, '__TAURI_INTERNALS__');
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  });

  afterEach(() => {
    if (clipboardDescriptor) {
      Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
    } else {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
    if (tauriDescriptor) {
      Object.defineProperty(window, '__TAURI_INTERNALS__', tauriDescriptor);
    } else {
      Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    }
  });

  it('uses the web clipboard in browser development', async () => {
    const web = {
      readText: vi.fn(async () => 'browser paste'),
      writeText: vi.fn(async () => undefined),
    };
    Object.defineProperty(navigator, 'clipboard', { value: web, configurable: true });

    await writeClipboardText('browser copy');
    await expect(readClipboardText()).resolves.toBe('browser paste');

    expect(web.writeText).toHaveBeenCalledWith('browser copy');
    expect(native.writeText).not.toHaveBeenCalled();
    expect(native.readText).not.toHaveBeenCalled();
  });

  it('uses the native plugin in a Tauri desktop window', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      configurable: true,
    });

    await writeClipboardText('native copy');
    await expect(readClipboardText()).resolves.toBe('native paste');

    expect(native.writeText).toHaveBeenCalledWith('native copy');
    expect(native.readText).toHaveBeenCalledOnce();
  });

  it('rejects instead of silently succeeding when the clipboard is unavailable', async () => {
    Reflect.deleteProperty(navigator, 'clipboard');

    await expect(writeClipboardText('lost')).rejects.toThrow('Clipboard write is unavailable');
    await expect(readClipboardText()).rejects.toThrow('Clipboard read is unavailable');
  });

  it('normalizes native IPC string failures for existing error surfaces', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      configurable: true,
    });
    native.writeText.mockRejectedValue('native clipboard refused');

    await expect(writeClipboardText('blocked')).rejects.toThrow('native clipboard refused');
  });

  it('reports fire-and-forget copy failures to the shared UI path', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('permission denied')) },
      configurable: true,
    });
    const message = new Promise<string>((resolve) => {
      const unsubscribe = subscribeClipboardErrors((error) => {
        unsubscribe();
        resolve(error);
      });
    });

    copyTextToClipboard('blocked');

    await expect(message).resolves.toBe('permission denied');
  });
});

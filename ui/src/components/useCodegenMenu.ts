/** The "copy as" menu, shared by Replay, Fuzzer and the history.
 *
 * All three want the same thing: take the request I am looking at and
 * give me something I can run somewhere else. The formats come from the
 * engine rather than being listed here, so a plugin that contributes one
 * appears in all three menus without any change to this file.
 */

import { useCallback, useEffect, useState } from 'react';

import { listCodegenFormats, openCsrfPoc, renderCode } from '../api/client';
import type { MenuItem } from './ContextMenu';
import { errorMessage, renderMessage, type Message } from '../i18n/message';
import { useT } from '../i18n';
import { notifyClipboardError, writeClipboardTextWithFeedback } from '../clipboard';
import { useToast } from './Toast';

export interface CodegenTarget {
  flow_id?: string;
  url?: string;
  method?: string;
  headers?: string[][];
  body?: string;
}

interface Format {
  kind: string;
  label: string;
  source: string;
}

// Shown until the engine answers, so the menu is never empty on first
// open. The engine remains the authority; this is only a placeholder.
const BUILTIN: Format[] = [
  { kind: 'curl', label: 'curl', source: 'builtin' },
  { kind: 'fetch', label: 'fetch', source: 'builtin' },
  { kind: 'python', label: 'Python requests', source: 'builtin' },
  { kind: 'csrf', label: 'CSRF proof of concept', source: 'builtin' },
];

/** Builds the submenu and performs the copy. */
export function useCodegenMenu(onError?: (message: Message) => void) {
  const t = useT();
  const { showToast } = useToast();
  const [formats, setFormats] = useState<Format[]>(BUILTIN);

  useEffect(() => {
    let alive = true;
    listCodegenFormats()
      .then((data) => {
        if (alive && data.formats?.length) setFormats(data.formats);
      })
      .catch(() => {
        // Keep the built-ins: a menu that works for the common formats is
        // better than one that vanishes because a plugin listing failed.
      });
    return () => {
      alive = false;
    };
  }, []);

  const copyAs = useCallback(
    async (kind: string, target: CodegenTarget) => {
      try {
        const { text } = await renderCode({ kind, ...target });
        const label = formats.find((format) => format.kind === kind)?.label ?? kind;
        await writeClipboardTextWithFeedback(
          text,
          t('menu.copiedAs', { kind: label }),
        );
      } catch (error) {
        if (onError) onError(errorMessage(error));
        else notifyClipboardError(error);
      }
    },
    [formats, onError, t],
  );

  const buildMenu = useCallback(
    (target: CodegenTarget | null): MenuItem => ({
      label: t('menu.copyAs'),
      separator: true,
      disabled: target == null,
      items: [
        ...formats.map((format) => ({
        label:
          format.kind === 'csrf'
            ? t('menu.csrfPoc')
            : format.source === 'builtin'
              ? format.label
              : // Plugin formats are labelled by the plugin, so mark where
                // they came from rather than passing them off as built in.
                `${format.label} (${format.source})`,
        onSelect: () => {
          if (target) void copyAs(format.kind, target);
        },
      })),
        {
          // Copying the HTML leaves the user to save it and open it
          // through the proxy by hand, which is most of the work.
          label: t('menu.openCsrfPoc'),
          separator: true,
          onSelect: async () => {
            if (!target) return;
            try {
              await openCsrfPoc(target);
              showToast({ message: t('menu.csrfPocOpened'), tone: 'success', category: 'browser' });
            } catch (error) {
              showToast({
                message: t('menu.csrfPocOpenFailed', {
                  message: renderMessage(errorMessage(error), t) ?? String(error),
                }),
                tone: 'error',
              });
            }
          },
        },
      ],
    }),
    [copyAs, formats, showToast, t],
  );

  return { buildMenu, copyAs, formats };
}

/** The "copy as" menu, shared by Repeater, Intruder and the history.
 *
 * All three want the same thing: take the request I am looking at and
 * give me something I can run somewhere else. The formats come from the
 * engine rather than being listed here, so a plugin that contributes one
 * appears in all three menus without any change to this file.
 */

import { useCallback, useEffect, useState } from 'react';

import { listCodegenFormats, openCsrfPoc, renderCode } from '../api/client';
import type { MenuItem } from './ContextMenu';
import { errorMessage, type Message } from '../i18n/message';
import { useT } from '../i18n';

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
  const [formats, setFormats] = useState<Format[]>(BUILTIN);
  const [copied, setCopied] = useState<string | null>(null);

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
        await navigator.clipboard?.writeText(text);
        setCopied(kind);
      } catch (error) {
        onError?.(errorMessage(error));
      }
    },
    [onError],
  );

  // Cleared on a timer so the confirmation does not sit there forever.
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(null), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

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
          onSelect: () => {
            if (!target) return;
            openCsrfPoc(target).catch((error: unknown) =>
              onError?.(errorMessage(error)),
            );
          },
        },
      ],
    }),
    [copyAs, formats, onError, t],
  );

  return { buildMenu, copyAs, copied, formats };
}

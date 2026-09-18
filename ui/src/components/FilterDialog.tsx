/** The history filter.
 *
 * A capture is mostly images, scripts and stylesheets, and the requests
 * worth looking at are a handful somewhere in the middle. One host, one
 * method and one status code was not enough to find them.
 *
 * Applied on close rather than as each box is ticked: building a filter
 * takes several clicks, and reloading the table after every one is both
 * slow and disorienting.
 */

import { useEffect, useState } from 'react';

import type { FlowFilters } from '../api/types';
import { Dialog } from './Dialog';
import { useT } from '../i18n';

/** The methods worth a checkbox. Anything else is still reachable
 *  through the search box. */
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/** By class, because 2xx is the useful unit rather than 200 against 201. */
const STATUS_CLASSES = [2, 3, 4, 5];

/** What a capture is mostly made of, and what people mute first. */
const COMMON_EXTENSIONS = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'ico',
  'css',
  'js',
  'woff',
  'woff2',
];

function toggle(list: string[], value: string): string[] {
  return list.includes(value)
    ? list.filter((v) => v !== value)
    : [...list, value];
}

/** Extensions as typed: trimmed, dot optional, blanks dropped. */
function parseExtensions(text: string): string[] {
  return text
    .split(',')
    .map((e) => e.trim().replace(/^\./, ''))
    .filter(Boolean);
}

/** The ones that have a checkbox. */
function commonOf(extensions: string[] | undefined): string[] {
  return (extensions ?? []).filter((e) => COMMON_EXTENSIONS.includes(e));
}

/** The ones with no checkbox, for the free-text box. */
function otherOf(extensions: string[] | undefined): string {
  return (extensions ?? [])
    .filter((e) => !COMMON_EXTENSIONS.includes(e))
    .join(', ');
}

export function FilterDialog({
  open,
  filters,
  onClose,
  onApply,
}: {
  open: boolean;
  filters: FlowFilters;
  onClose: () => void;
  onApply: (filters: FlowFilters) => void;
}) {
  const t = useT();
  // Edited locally so a half-built filter is not applied on the way.
  const [draft, setDraft] = useState<FlowFilters>(filters);
  // The ticked boxes and the typed text are kept apart and merged on
  // the way out. Merged state cannot tell them apart, so typing ".js"
  // on the way to ".json" ticked the js box and left it ticked.
  const [ticked, setTicked] = useState(() => commonOf(filters.extensions));
  const [otherText, setOtherText] = useState(() => otherOf(filters.extensions));

  useEffect(() => {
    if (open) {
      setDraft(filters);
      setTicked(commonOf(filters.extensions));
      setOtherText(otherOf(filters.extensions));
    }
  }, [open, filters]);

  const methods = draft.methods ?? [];
  const classes = draft.statusClasses ?? [];
  const setInclude = (boxes: string[], text: string) => {
    setTicked(boxes);
    setOtherText(text);
    set({ extensions: [...boxes, ...parseExtensions(text)] });
  };
  const exclude = draft.excludeExtensions ?? [];

  const set = (patch: Partial<FlowFilters>) =>
    setDraft((current) => ({ ...current, ...patch }));

  return (
    <Dialog
      open={open}
      title={t('filter.title')}
      onClose={onClose}
      className="filter-dialog"
      footer={
        <>
          <button
            type="button"
            onClick={() => {
              // Keeps the free-text search: it is typed in the bar and
              // clearing it from in here would be a surprise.
              setDraft({ search: draft.search });
              setTicked([]);
              setOtherText('');
            }}
          >
            {t('filter.reset')}
          </button>
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="send"
            onClick={() => {
              onApply(draft);
              onClose();
            }}
          >
            {t('filter.apply')}
          </button>
        </>
      }
    >
      <div className="filter-grid">
        <section>
          <h5>{t('filter.methods')}</h5>
          <div className="filter-checks">
            {METHODS.map((method) => (
              <label key={method}>
                <input
                  type="checkbox"
                  checked={methods.includes(method)}
                  onChange={() => set({ methods: toggle(methods, method) })}
                />
                {method}
              </label>
            ))}
          </div>
          {/* Nothing ticked means everything, which is less surprising
              than an empty table. */}
          <p className="muted">{t('filter.allWhenEmpty')}</p>
        </section>

        <section>
          <h5>{t('filter.status')}</h5>
          <div className="filter-checks">
            {STATUS_CLASSES.map((cls) => (
              <label key={cls}>
                <input
                  type="checkbox"
                  checked={classes.includes(cls)}
                  onChange={() =>
                    set({
                      statusClasses: classes.includes(cls)
                        ? classes.filter((c) => c !== cls)
                        : [...classes, cls],
                    })
                  }
                />
                {cls}xx
              </label>
            ))}
          </div>
          <p className="muted">{t('filter.statusHelp')}</p>
        </section>

        <section>
          <h5>{t('filter.host')}</h5>
          <input
            aria-label={t('filter.host')}
            placeholder={t('filter.hostPlaceholder')}
            value={draft.host ?? ''}
            onChange={(event) => set({ host: event.target.value || undefined })}
          />
          <label className="filter-toggle">
            <input
              type="checkbox"
              checked={draft.inScopeOnly ?? false}
              onChange={(event) => set({ inScopeOnly: event.target.checked })}
            />
            {t('filter.inScopeOnly')}
          </label>
        </section>

        <section>
          <h5>{t('filter.showOnly')}</h5>
          <div className="filter-checks">
            {COMMON_EXTENSIONS.map((ext) => (
              <label key={ext}>
                <input
                  type="checkbox"
                  checked={ticked.includes(ext)}
                  onChange={() => setInclude(toggle(ticked, ext), otherText)}
                />
                {ext}
              </label>
            ))}
          </div>
          {/* The text is kept as typed. Deriving it back from the parsed
              list ate the separator: "php," parses to ["php"], which
              renders as "php", so the comma vanished as it was typed. */}
          <input
            aria-label={t('filter.showOnlyOther')}
            placeholder={t('filter.extensionsPlaceholder')}
            value={otherText}
            onChange={(event) => setInclude(ticked, event.target.value)}
          />
        </section>

        <section>
          <h5>{t('filter.hide')}</h5>
          <div className="filter-checks">
            {COMMON_EXTENSIONS.map((ext) => (
              <label key={ext}>
                <input
                  type="checkbox"
                  checked={exclude.includes(ext)}
                  onChange={() =>
                    set({ excludeExtensions: toggle(exclude, ext) })
                  }
                />
                {ext}
              </label>
            ))}
          </div>
          <button
            type="button"
            className="link-button"
            onClick={() => set({ excludeExtensions: [...COMMON_EXTENSIONS] })}
          >
            {t('filter.hideAllStatic')}
          </button>
        </section>
      </div>
    </Dialog>
  );
}

/** How many filters are active, for the button that opens this. */
export function countActive(filters: FlowFilters): number {
  return (
    (filters.methods?.length ? 1 : 0) +
    (filters.statusClasses?.length ? 1 : 0) +
    (filters.extensions?.length ? 1 : 0) +
    (filters.excludeExtensions?.length ? 1 : 0) +
    (filters.host ? 1 : 0) +
    (filters.inScopeOnly ? 1 : 0)
  );
}

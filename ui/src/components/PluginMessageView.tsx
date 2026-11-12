/** Plugin tabs beside Pretty, Raw and Hex.
 *
 * A plugin renders a message its own way, for example decrypting an
 * end-to-end encrypted body. Where the raw message is editable and the
 * plugin can reverse its rendering, the tab is editable too: the edited
 * text goes back through the plugin and the result replaces Raw, so what
 * is sent is still exactly the raw text.
 */

import { useEffect, useRef, useState } from 'react';

import { applyPluginMessageView, renderPluginMessageView } from '../api/client';
import type { PluginMessageInput, PluginMessageViewContribution } from '../api/types';
import { useT } from '../i18n';
import { MarkedText } from './MarkedText';
import { LoadingPane } from './Spinner';
import { pluginViewKey, type PluginViewKey } from './pluginMessageViews';

const RENDER_DELAY_MS = 150;
const APPLY_DELAY_MS = 400;

/** Tab buttons for plugin views, to follow the built-in ones. */
export function PluginViewTabs({
  views,
  active,
  onSelect,
}: {
  views: PluginMessageViewContribution[];
  active: string;
  onSelect: (key: PluginViewKey) => void;
}) {
  return <>
    {views.map((view) => {
      const key = pluginViewKey(view);
      return <button
        key={key}
        type="button"
        role="tab"
        aria-selected={active === key}
        className={`plugin-view-tab${active === key ? ' active' : ''}`}
        title={view.description ? `${view.description} · ${view.plugin}` : view.plugin}
        onClick={() => onSelect(key)}
      >
        {view.title}
      </button>;
    })}
  </>;
}

type Rendered =
  | { key: string; state: 'ready'; text: string }
  | { key: string; state: 'none' }
  | { key: string; state: 'error'; message: string };

export function PluginMessageView({
  view,
  message,
  onChange,
  query = '',
  activeIndex = null,
  onText,
  className,
  wrap = true,
}: {
  view: PluginMessageViewContribution;
  message: Omit<PluginMessageInput, 'editable'>;
  /** Given where Raw is editable; the tab is editable only if the plugin can apply. */
  onChange?: (raw: string) => void;
  query?: string;
  activeIndex?: number | null;
  /** Reports the shown text so the host pane can count find matches. */
  onText?: (text: string) => void;
  className?: string;
  wrap?: boolean;
}) {
  const t = useT();
  const editable = Boolean(onChange && view.editable);
  const { side, location, raw, flow_id: flowId = null, body_truncated: bodyTruncated = false } = message;
  const renderKey = JSON.stringify([view.id, side, location, flowId, bodyTruncated, raw]);
  const [rendered, setRendered] = useState<Rendered | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [applyState, setApplyState] = useState<{ state: 'pending' | 'applied' } | { state: 'error'; message: string } | null>(null);
  // The raw message the current text belongs to: rendered from it, or
  // produced from it by apply. Raw changing to anything else re-renders.
  const ownedRaw = useRef<string | null>(null);
  const applyTimer = useRef<number | undefined>(undefined);
  const applySequence = useRef(0);
  const sourceMessage = useRef<PluginMessageInput | null>(null);

  useEffect(() => {
    if (editable && ownedRaw.current === raw) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const input: PluginMessageInput = { side, location, raw, flow_id: flowId, body_truncated: bodyTruncated, editable };
      renderPluginMessageView(view.id, input, controller.signal)
        .then(({ text }) => {
          if (controller.signal.aborted) return;
          sourceMessage.current = input;
          ownedRaw.current = raw;
          setRendered(text === null ? { key: renderKey, state: 'none' } : { key: renderKey, state: 'ready', text });
          setDraft(text);
          setApplyState(null);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setRendered({ key: renderKey, state: 'error', message: error instanceof Error ? error.message : String(error) });
        });
    }, RENDER_DELAY_MS);
    return () => { window.clearTimeout(timer); controller.abort(); };
    // renderKey covers every input; it is listed instead of them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderKey, editable]);

  useEffect(() => {
    const sequence = applySequence;
    return () => {
      // A result arriving after unmount belongs to a document no longer shown.
      window.clearTimeout(applyTimer.current);
      sequence.current += 1;
    };
  }, []);

  const rawIsOwned = ownedRaw.current === raw;
  const shownText = draft ?? (rendered?.state === 'ready' ? rendered.text : '');
  useEffect(() => { onText?.(rendered?.state === 'ready' ? shownText : ''); }, [onText, rendered, shownText]);

  const edit = (text: string) => {
    setDraft(text);
    setApplyState({ state: 'pending' });
    window.clearTimeout(applyTimer.current);
    const sequence = ++applySequence.current;
    applyTimer.current = window.setTimeout(() => {
      const source = sourceMessage.current;
      if (!source || !onChange) return;
      applyPluginMessageView(view.id, text, source)
        .then(({ raw: next }) => {
          if (sequence !== applySequence.current) return;
          ownedRaw.current = next;
          onChange(next);
          setApplyState({ state: 'applied' });
        })
        .catch((error: unknown) => {
          if (sequence !== applySequence.current) return;
          setApplyState({ state: 'error', message: error instanceof Error ? error.message : String(error) });
        });
    }, APPLY_DELAY_MS);
  };

  // Never show one message's rendering under another. Raw changed by our
  // own apply still belongs to the text being edited.
  const current = rendered && (rendered.key === renderKey || (editable && rawIsOwned)) ? rendered : null;
  let body;
  if (!current) {
    body = <LoadingPane label={t('plugins.messageView.loading')} />;
  } else if (current.state === 'error') {
    body = <p className="banner error">{t('plugins.messageView.failed', { name: view.title, message: current.message })}</p>;
  } else if (current.state === 'none') {
    body = <p className="muted plugin-message-view-empty">{t('plugins.messageView.notApplicable', { name: view.title })}</p>;
  } else if (editable) {
    body = <textarea
      className={`plugin-message-view-editor ${className ?? 'mono'}`}
      aria-label={view.title}
      spellCheck={false}
      value={shownText}
      onChange={(event) => edit(event.target.value)}
      style={{ whiteSpace: wrap ? 'pre-wrap' : 'pre' }}
    />;
  } else {
    body = <pre className={`plugin-message-view-text ${className ?? 'mono'}`} style={{ whiteSpace: wrap ? 'pre-wrap' : 'pre' }}>
      <MarkedText text={shownText} query={query} activeIndex={activeIndex} />
    </pre>;
  }

  return <div className="plugin-message-view" data-plugin-view={view.id}>
    <div className="plugin-message-view-status muted">
      <span>{view.plugin}</span>
      {bodyTruncated && <span>{t('plugins.messageView.truncated')}</span>}
      {current?.state === 'ready' && !editable && <span>{t('editor.viewOnly')}</span>}
      {applyState?.state === 'pending' && <span>{t('plugins.messageView.applying')}</span>}
      {applyState?.state === 'applied' && <span>{t('plugins.messageView.applied')}</span>}
      {applyState?.state === 'error' && <span className="plugin-error-text" role="alert">{t('plugins.messageView.applyFailed', { message: applyState.message })}</span>}
    </div>
    {body}
  </div>;
}

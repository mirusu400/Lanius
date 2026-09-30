import { useEffect, useRef, useState } from 'react';

import { sendReplayRequest } from '../api/client';
import {
  emptyTab,
  nextTabId,
  renderResponseText,
  toSendPayload,
  trimResponse,
  type ReplayTab,
} from './replayModel';
import {
  addTab,
  removeTab,
  subscribe,
  updateTab,
} from './replayStore';
import { ContextMenu, useContextMenu } from '../components/ContextMenu';
import { useCodegenMenu } from '../components/useCodegenMenu';
import { RequestEditor } from '../components/RequestEditor';
import { Split } from '../components/Split';
import { ResponseInspector } from '../components/ResponseInspector';
import { formatMessageBody, minify, splitMessage } from '../components/bodyFormat';
import { useEditorMenu } from '../components/useEditorMenu';
import { usePluginActions } from '../components/usePluginActions';
import { errorMessage, rawMsg, renderMessage, useT } from '../i18n';
import { sendTextToFuzzer } from './fuzzerStore';
import { useShortcut } from '../useShortcut';

export function ReplayTabView() {
  const t = useT();
  const [tabs, setTabs] = useState<ReplayTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  const menu = useContextMenu<string>();

  useEffect(() => subscribe(setTabs), []);

  useEffect(() => {
    if (tabs.length === 0) {
      setActiveId(null);
      return;
    }
    if (!activeId || !tabs.some((t) => t.id === activeId)) {
      setActiveId(tabs[tabs.length - 1].id);
    }
  }, [tabs, activeId]);

  const active = tabs.find((t) => t.id === activeId) ?? null;
  const sendingIds = useRef(new Set<string>());

  const createTab = () => {
    const next = addTab(emptyTab());
    setActiveId(next.id);
  };

  const duplicateTab = (source: ReplayTab) => {
    const next = addTab({ ...source, id: nextTabId(), sending: false, error: null });
    setActiveId(next.id);
  };

  const closeTab = (id: string) => {
    const index = tabs.findIndex((item) => item.id === id);
    if (index < 0) return;
    setActiveId(tabs[index + 1]?.id ?? tabs[index - 1]?.id ?? null);
    removeTab(id);
  };

  const selectRelativeTab = (step: number) => {
    if (!active || tabs.length < 2) return;
    const index = tabs.findIndex((item) => item.id === active.id);
    setActiveId(tabs[(index + step + tabs.length) % tabs.length].id);
  };

  // The request here has been edited, so carrying it to Fuzzer as text
  // keeps those edits; going back to the history would lose them.
  const codegen = useCodegenMenu();
  // Built from the text in the editor, not from the flow it came from,
  // so the code matches the request as it has been edited.
  const codegenTarget = () => {
    if (!active) return null;
    try {
      const payload = toSendPayload(active.url, active.text);
      return {
        url: payload.url,
        method: payload.method,
        headers: payload.headers,
        body: payload.body,
      };
    } catch {
      // A half-typed request cannot be rendered; the menu entry is
      // disabled rather than copying something misleading.
      return null;
    }
  };
  const pluginActions = usePluginActions((message) => {
    if (active) updateTab(active.id, { error: rawMsg(message) });
  });
  const pluginMenu = active
    ? pluginActions.buildMenu(
        ['replay', 'request'],
        {
          replay_tab_id: active.id,
          url: active.url,
          raw_request: active.text,
          request: codegenTarget(),
          response: active.response,
        },
      )
    : undefined;

  const editorMenu = useEditorMenu(
    [
      {
        label: t('editor.sendToFuzzer'),
        onSelect: (_selection, editor) => {
          if (active) sendTextToFuzzer(active.url, editor.value);
        },
      },
      // An explicit action rather than a view toggle: this rewrites the
      // request you are editing, so it has to be something you asked
      // for and can undo, not a display mode you might not notice.
      {
        label: t('body.format'),
        onSelect: (_selection, editor) => {
          if (!active) return;
          const next = formatMessageBody(editor.value, 'pretty');
          if (next !== editor.value) updateTab(active.id, { text: next });
        },
      },
      {
        label: t('body.minify'),
        onSelect: (_selection, editor) => {
          if (!active) return;
          const { head, separator, body } = splitMessage(editor.value);
          if (!separator) return;
          const next = `${head}${separator}${minify(body)}`;
          if (next !== editor.value) updateTab(active.id, { text: next });
        },
      },
    ],
    [
      codegen.buildMenu(codegenTarget()),
      ...(pluginMenu ? [pluginMenu] : []),
    ],
  );

  const send = async () => {
    if (!active || active.sending || sendingIds.current.has(active.id)) return;
    const requestId = active.id;
    sendingIds.current.add(requestId);
    updateTab(active.id, { sending: true, error: null });
    try {
      const payload = toSendPayload(active.url, active.text);
      const response = await sendReplayRequest(payload);
      updateTab(requestId, { response: trimResponse(response), sending: false });
    } catch (err) {
      updateTab(requestId, { sending: false, error: errorMessage(err) });
    } finally {
      sendingIds.current.delete(requestId);
    }
  };

  useShortcut('replay.send', send, Boolean(active && !active.sending));
  useShortcut('replay.new', createTab);
  useShortcut('replay.duplicate', () => {
    if (active) duplicateTab(active);
  }, Boolean(active));
  useShortcut('replay.close', () => {
    if (active) closeTab(active.id);
  }, Boolean(active));
  useShortcut('replay.previous', () => selectRelativeTab(-1), Boolean(active && tabs.length > 1));
  useShortcut('replay.next', () => selectRelativeTab(1), Boolean(active && tabs.length > 1));

  return (
    <div className="replay-tab">
      <div className="subtabs replay-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={tab.id === activeId ? 'active' : ''}
            onClick={() => setActiveId(tab.id)}
            onContextMenu={(event) => menu.open(event, tab.id)}
          >
            <span className="tab-title" title={tab.title}>
              {tab.title}
            </span>
            <span
              className="close"
              role="button"
              aria-label={t('replay.closeTab', { title: tab.title })}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
              }}
            >
              ×
            </span>
          </button>
        ))}
        <button className="new-tab" onClick={createTab}>
          +
        </button>
        <ContextMenu
          position={menu.position}
          items={
            menu.target
              ? [
                  {
                    label: t('menu.duplicate'),
                    onSelect: () => {
                      const source = tabs.find((tab) => tab.id === menu.target);
                      // Copying a request to try a variation without
                      // losing the original is the common Replay move.
                      if (source) duplicateTab(source);
                    },
                  },
                  {
                    label: t('menu.closeTab'),
                    separator: true,
                    onSelect: () => closeTab(menu.target as string),
                  },
                  {
                    label: t('menu.closeOthers'),
                    disabled: tabs.length < 2,
                    onSelect: () => {
                      for (const tab of tabs) {
                        if (tab.id !== menu.target) removeTab(tab.id);
                      }
                    },
                  },
                ]
              : []
          }
          onClose={menu.close}
        />
      </div>

      {active ? (
        <>
          <div className="replay-controls">
            <input
              className="target"
              value={active.url}
              onChange={(e) => updateTab(active.id, { url: e.target.value })}
              placeholder={t('replay.targetPlaceholder')}
            />
            <button
              className="send"
              onClick={send}
              disabled={active.sending}
            >
              {active.sending ? t('replay.sending') : t('replay.send')}
            </button>
            {active.response && (
              <span className="resp-meta mono">
                {active.response.status_code ?? 'ERR'} ·{' '}
                {active.response.size} B ·{' '}
                {active.response.duration_ms === null
                  ? '-'
                  : `${Math.round(active.response.duration_ms)} ms`}
              </span>
            )}
          </div>
          {active.error && (
            <div className="banner error">{renderMessage(active.error, t)}</div>
          )}
          <Split
            direction="horizontal"
            storageKey="lanius.split.replay"
            className="replay-split"
            first={<RequestEditor
              editorRef={editorMenu.ref}
              className="replay-editor mono"
              label={t('replay.request')}
              value={active.text}
              onChange={(text) => updateTab(active.id, { text })}
              onContextMenu={editorMenu.open}
            />}
            second={<ResponseInspector
              flowId={active.response?.id ?? null}
              raw={active.response
                ? renderResponseText(active.response, (count) =>
                    t('replay.bodyTruncated', { count: String(count) }),
                  )
                : undefined}
              empty={t('replay.noResponse')}
            />}
          />
          {editorMenu.element}
        </>
      ) : (
        <div className="intercept-idle muted">
          {t('replay.noTabs')}
        </div>
      )}
    </div>
  );
}

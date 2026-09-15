import { useEffect, useState } from 'react';

import { sendRepeaterRequest } from '../api/client';
import {
  emptyTab,
  renderResponseText,
  toSendPayload,
  trimResponse,
  type RepeaterTab,
} from './repeaterModel';
import {
  addTab,
  removeTab,
  subscribe,
  updateTab,
} from './repeaterStore';
import { ContextMenu, useContextMenu } from '../components/ContextMenu';
import { useEditorMenu } from '../components/useEditorMenu';
import { sendTextToIntruder } from './intruderStore';
import { errorMessage, renderMessage, useT } from '../i18n';

export function RepeaterTabView() {
  const t = useT();
  const [tabs, setTabs] = useState<RepeaterTab[]>([]);
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

  // The request here has been edited, so carrying it to Intruder as text
  // keeps those edits; going back to the history would lose them.
  const editorMenu = useEditorMenu([
    {
      label: t('editor.sendToIntruder'),
      onSelect: (_selection, editor) => {
        if (active) sendTextToIntruder(active.url, editor.value);
      },
    },
  ]);

  const send = async () => {
    if (!active) return;
    updateTab(active.id, { sending: true, error: null });
    try {
      const payload = toSendPayload(active.url, active.text);
      const response = await sendRepeaterRequest(payload);
      updateTab(active.id, { response: trimResponse(response), sending: false });
    } catch (err) {
      updateTab(active.id, { sending: false, error: errorMessage(err) });
    }
  };

  return (
    <div className="repeater-tab">
      <div className="subtabs repeater-tabs">
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
              aria-label={t('repeater.closeTab', { title: tab.title })}
              onClick={(e) => {
                e.stopPropagation();
                removeTab(tab.id);
              }}
            >
              ×
            </span>
          </button>
        ))}
        <button className="new-tab" onClick={() => addTab(emptyTab())}>
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
                      // losing the original is the common Repeater move.
                      if (source) addTab({ ...source, id: `r${Date.now()}` });
                    },
                  },
                  {
                    label: t('menu.closeTab'),
                    separator: true,
                    onSelect: () => removeTab(menu.target as string),
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
          <div className="repeater-controls">
            <input
              className="target"
              value={active.url}
              onChange={(e) => updateTab(active.id, { url: e.target.value })}
              placeholder={t('repeater.targetPlaceholder')}
            />
            <button
              className="send"
              onClick={send}
              disabled={active.sending}
            >
              {active.sending ? t('repeater.sending') : t('repeater.send')}
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
          <div className="repeater-split">
            <textarea
              ref={editorMenu.ref}
              className="repeater-editor mono"
              aria-label={t('repeater.request')}
              spellCheck={false}
              value={active.text}
              onChange={(e) => updateTab(active.id, { text: e.target.value })}
              onContextMenu={editorMenu.open}
            />
            {editorMenu.element}
            <pre className="repeater-response mono">
              {active.response
                ? renderResponseText(active.response, (count) =>
                    t('repeater.bodyTruncated', { count: String(count) }),
                  )
                : t('repeater.noResponse')}
            </pre>
          </div>
        </>
      ) : (
        <div className="intercept-idle muted">
          {t('repeater.noTabs')}
        </div>
      )}
    </div>
  );
}

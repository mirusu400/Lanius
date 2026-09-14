import { useEffect, useState } from 'react';

import { sendRepeaterRequest } from '../api/client';
import {
  emptyTab,
  renderResponseText,
  toSendPayload,
  type RepeaterTab,
} from './repeaterModel';
import {
  addTab,
  removeTab,
  subscribe,
  updateTab,
} from './repeaterStore';
import { ContextMenu, useContextMenu } from '../components/ContextMenu';
import { errorText, useT } from '../i18n';

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

  const send = async () => {
    if (!active) return;
    updateTab(active.id, { sending: true, error: null });
    try {
      const payload = toSendPayload(active.url, active.text);
      const response = await sendRepeaterRequest(payload);
      updateTab(active.id, { response, sending: false });
    } catch (err) {
      updateTab(active.id, { sending: false, error: errorText(err, t) });
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
            {tab.title}
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
          {active.error && <div className="banner error">{active.error}</div>}
          <div className="repeater-split">
            <textarea
              className="repeater-editor mono"
              aria-label={t('repeater.request')}
              spellCheck={false}
              value={active.text}
              onChange={(e) => updateTab(active.id, { text: e.target.value })}
            />
            <pre className="repeater-response mono">
              {active.response
                ? renderResponseText(active.response)
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

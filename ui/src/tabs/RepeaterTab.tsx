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

export function RepeaterTabView() {
  const [tabs, setTabs] = useState<RepeaterTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

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
      updateTab(active.id, { sending: false, error: (err as Error).message });
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
          >
            {tab.title}
            <span
              className="close"
              role="button"
              aria-label={`close ${tab.title}`}
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
      </div>

      {active ? (
        <>
          <div className="repeater-controls">
            <input
              className="target"
              value={active.url}
              onChange={(e) => updateTab(active.id, { url: e.target.value })}
              placeholder="http://host:port"
            />
            <button
              className="send"
              onClick={send}
              disabled={active.sending}
            >
              {active.sending ? 'Sending…' : 'Send'}
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
              aria-label="request"
              spellCheck={false}
              value={active.text}
              onChange={(e) => updateTab(active.id, { text: e.target.value })}
            />
            <pre className="repeater-response mono">
              {active.response
                ? renderResponseText(active.response)
                : '아직 응답이 없습니다. Send를 눌러 요청을 전송하세요.'}
            </pre>
          </div>
        </>
      ) : (
        <div className="intercept-idle muted">
          Repeater 탭이 없습니다. Proxy 히스토리에서 "Send to Repeater"를
          누르거나 +로 새 요청을 만드세요.
        </div>
      )}
    </div>
  );
}

/** The MCP endpoint that lets an agent read the capture. */

import { useEffect, useState } from 'react';
import {
  getMcpState,
  setMcpEnabled,
} from '../../api/client';
import type { McpState } from '../../api/types';
import {
  msg,
  rawMsg,
  renderMessage,
  useI18n,
  type Message,
} from '../../i18n';

export function McpSection() {
  const { t } = useI18n();
  const [state, setState] = useState<McpState | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Message | null>(null);
  const [error, setError] = useState<Message | null>(null);

  useEffect(() => {
    getMcpState()
      .then((next) => setState({ ...next, tools: next.tools ?? [] }))
      .catch((err) => setError(rawMsg((err as Error).message)));
  }, []);

  if (!state) return null;

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const next = await setMcpEnabled(enabled);
      setState({ ...next, tools: next.tools ?? [] });
    } catch (err) {
      setError(rawMsg((err as Error).message));
    } finally {
      setBusy(false);
    }
  };

  // What a user pastes into their agent's config. Written out here rather
  // than in the docs so it carries the port this engine is actually on.
  const clientConfig = JSON.stringify(
    { mcpServers: { lanius: { url: state.url } } },
    null,
    2,
  );

  const copyConfig = async () => {
    try {
      await navigator.clipboard.writeText(clientConfig);
      setNote(msg('mcp.copied'));
    } catch (err) {
      setError(rawMsg((err as Error).message));
    }
  };

  const acting = state.tools.filter((tool) => tool.writes).length;

  return (
    <section>
      <h3>{t('mcp.section')}</h3>
      <p className="muted">{t('mcp.help')}</p>

      {!state.available ? (
        <div className="banner error">{t('mcp.unavailable')}</div>
      ) : (
        <>
          <div className="settings-row">
            <label htmlFor="mcp-enabled">
              <input
                id="mcp-enabled"
                type="checkbox"
                checked={state.enabled}
                disabled={busy}
                onChange={(event) => void toggle(event.target.checked)}
              />{' '}
              {t('mcp.enable')}
            </label>
          </div>
          <p className={state.enabled ? 'muted' : 'banner warn'}>
            {state.enabled ? t('mcp.enabled') : t('mcp.disabled')}
          </p>

          <dl className="settings-grid mono">
            <dt>{t('mcp.endpoint')}</dt>
            <dd>{state.url}</dd>
          </dl>
          <p className="muted">{t('mcp.localOnly')}</p>

          <div className="settings-row">
            <button type="button" disabled={busy} onClick={() => void copyConfig()}>
              {t('mcp.copy')}
            </button>
          </div>

          {state.tools.length > 0 && (
            <>
              <h4>{t('mcp.toolsHeading', { count: state.tools.length })}</h4>
              <ul className="mcp-tools">
                {state.tools.map((tool) => (
                  <li key={tool.name}>
                    <code>{tool.name}</code>
                    <span className={tool.writes ? 'pill warn' : 'pill'}>
                      {tool.writes ? t('mcp.writes') : t('mcp.readOnly')}
                    </span>
                    <span className="muted">{tool.description}</span>
                  </li>
                ))}
              </ul>
              {acting > 0 && (
                <p className="banner warn">{t('mcp.writesWarning')}</p>
              )}
            </>
          )}
        </>
      )}

      {note && <p className="muted">{renderMessage(note, t)}</p>}
      {error && <div className="banner error">{renderMessage(error, t)}</div>}
    </section>
  );
}

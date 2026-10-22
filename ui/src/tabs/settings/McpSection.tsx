/** The MCP endpoint that lets an agent read the capture. */

import { useEffect, useRef, useState } from 'react';
import { useSettingsToast } from '../../components/useSettingsToast';
import {
  getMcpState,
  isDesktop,
  setDesktopApiPort,
  setMcpEnabled,
} from '../../api/client';
import type { McpState } from '../../api/types';
import { connectStream } from '../../api/stream';
import {
  msg,
  rawMsg,
  renderMessage,
  useI18n,
  type Message,
} from '../../i18n';
import { UndoableInput } from '../../components/UndoableText';
import { writeClipboardText } from '../../clipboard';

export function McpSection() {
  const { t } = useI18n();
  const saved = useSettingsToast('mcp.section');
  const [state, setState] = useState<McpState | null>(null);
  const [port, setPort] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Message | null>(null);
  const [error, setError] = useState<Message | null>(null);
  const [toolQuery, setToolQuery] = useState('');
  const [openToolGroups, setOpenToolGroups] = useState<Set<string>>(
    () => new Set(['']),
  );
  const generation = useRef(0);

  useEffect(() => {
    let live = true;
    const refresh = () => {
      const request = ++generation.current;
      void getMcpState()
        .then((next) => {
          if (!live || request !== generation.current) return;
          setState({ ...next, tools: next.tools ?? [] });
          setPort((current) => current || String(next.port));
          setError(null);
        })
        .catch((err) => {
          if (live && request === generation.current) setError(rawMsg((err as Error).message));
        });
    };
    refresh();
    const disconnect = connectStream({
      onEvent: (event) => {
        if (event.type === 'mcp.tools_changed') refresh();
      },
      onState: (connection) => { if (connection === 'open') refresh(); },
    });
    return () => { live = false; disconnect(); };
  }, []);

  if (!state) {
    return (
      <section>
        <h3>{t('mcp.section')}</h3>
        <p className="muted">{t('mcp.help')}</p>
        {error
          ? <div className="banner error">{renderMessage(error, t)}</div>
          : <p className="muted">{t('common.loading')}</p>}
      </section>
    );
  }

  const toggle = async (enabled: boolean) => {
    ++generation.current;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const next = await setMcpEnabled(enabled);
      ++generation.current;
      setState({ ...next, tools: next.tools ?? [] });
      saved();
    } catch (err) {
      setError(rawMsg((err as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const applyPort = async () => {
    const wanted = Number(port);
    if (!Number.isInteger(wanted) || wanted < 1 || wanted > 65535) {
      setError(msg('mcp.portInvalid'));
      return;
    }
    setBusy(true);
    setNote(null);
    ++generation.current;
    setError(null);
    try {
      await setDesktopApiPort(wanted);
      const next = await getMcpState();
      ++generation.current;
      setState({ ...next, tools: next.tools ?? [] });
      setPort(String(next.port));
      setNote(msg('mcp.portApplied', { port: next.port }));
      saved();
    } catch (err) {
      setError(rawMsg((err as Error).message));
    } finally {
      setBusy(false);
    }
  };

  // What a user pastes into their agent's config. Written out here rather
  // than in the docs so it carries the port this engine is actually on.
  const clientConfig = JSON.stringify(
    { mcpServers: { lanius: { type: 'http', url: state.url } } },
    null,
    2,
  );

  const clientCommands = [
    { name: 'Codex', command: `codex mcp add lanius --url ${state.url}` },
    {
      name: 'Claude Code',
      command: `claude mcp add --transport http --scope user lanius ${state.url}`,
    },
  ];

  const copy = async (value: string, success: Message) => {
    try {
      await writeClipboardText(value);
      setNote(success);
      setError(null);
    } catch (err) {
      setError(rawMsg((err as Error).message));
    }
  };

  const acting = state.tools.filter((tool) => tool.writes).length;
  const normalizedToolQuery = toolQuery.trim().toLowerCase();
  const visibleTools = state.tools.filter((tool) => !normalizedToolQuery || [
    tool.name,
    tool.description,
    tool.plugin ?? '',
  ].some((value) => value.toLowerCase().includes(normalizedToolQuery)));
  const toolGroups = Array.from(visibleTools.reduce((groups, tool) => {
    const owner = tool.plugin ?? '';
    const tools = groups.get(owner) ?? [];
    tools.push(tool);
    groups.set(owner, tools);
    return groups;
  }, new Map<string, McpState['tools']>())).sort(([left], [right]) => {
    if (!left) return right ? -1 : 0;
    if (!right) return 1;
    return left.localeCompare(right);
  });

  const rememberToolGroup = (owner: string, open: boolean) => {
    setOpenToolGroups((current) => {
      if (current.has(owner) === open) return current;
      const next = new Set(current);
      if (open) next.add(owner);
      else next.delete(owner);
      return next;
    });
  };

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

          {isDesktop() && (
            <div className="settings-row">
              <label htmlFor="mcp-port">{t('mcp.port')}</label>
              <UndoableInput
                id="mcp-port"
                type="number"
                min="1"
                max="65535"
                value={port}
                disabled={busy}
                onValueChange={setPort}
              />
              <button
                type="button"
                disabled={busy || port === String(state.port)}
                onClick={() => void applyPort()}
              >
                {t('mcp.applyPort')}
              </button>
              <span className="muted">{t('mcp.portHelp')}</span>
            </div>
          )}

          <h4>{t('mcp.setupHeading')}</h4>
          <p className="muted">{t('mcp.setupHelp')}</p>
          <div className="mcp-client-commands">
            {clientCommands.map(({ name, command }) => (
              <div className="mcp-client-command" key={name}>
                <strong>{name}</strong>
                <code>{command}</code>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void copy(command, msg('mcp.commandCopied'))}
                  aria-label={t('mcp.copyCommand', { client: name })}
                >
                  {t('mcp.copyButton')}
                </button>
              </div>
            ))}
          </div>

          <div className="settings-row">
            <button type="button" disabled={busy} onClick={() => void copy(clientConfig, msg('mcp.copied'))}>
              {t('mcp.copy')}
            </button>
          </div>

          {state.tools.length > 0 && (
            <>
              <h4>{t('mcp.toolsHeading', { count: state.tools.length })}</h4>
              <div className="mcp-tool-filter" role="search">
                <input
                  type="search"
                  value={toolQuery}
                  onChange={(event) => setToolQuery(event.target.value)}
                  aria-label={t('mcp.toolsSearch')}
                  placeholder={t('mcp.toolsSearch')}
                />
                <span className="muted">{visibleTools.length}/{state.tools.length}</span>
              </div>
              {toolGroups.length > 0 ? (
                <div className="mcp-tool-groups">
                  {toolGroups.map(([owner, tools]) => (
                    <details
                      className="mcp-tool-group"
                      key={owner || 'built-in'}
                      open={Boolean(normalizedToolQuery) || openToolGroups.has(owner)}
                      onToggle={(event) => {
                        if (!normalizedToolQuery) {
                          rememberToolGroup(owner, event.currentTarget.open);
                        }
                      }}
                    >
                      <summary>
                        <span className="mcp-tool-group-summary">
                          <strong className="mcp-tool-group-label" title={owner || undefined}>
                            {owner
                              ? t('mcp.pluginTools', { plugin: owner })
                              : t('mcp.builtInTools')}
                          </strong>
                          <span className="pill">{tools.length}</span>
                        </span>
                      </summary>
                      <ul className="mcp-tools">
                        {tools.map((tool) => (
                          <li key={tool.name}>
                            <code>{tool.name}</code>
                            <span className="mcp-tool-meta">
                              {tool.plugin && (
                                <span className="pill mcp-tool-owner" title={tool.plugin}>
                                  {tool.plugin}
                                </span>
                              )}
                              <span className={tool.writes ? 'pill warn' : 'pill'}>
                                {tool.writes ? t('mcp.writes') : t('mcp.readOnly')}
                              </span>
                            </span>
                            <span className="mcp-tool-description muted">{tool.description}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ))}
                </div>
              ) : (
                <p className="muted">{t('mcp.noToolMatches')}</p>
              )}
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

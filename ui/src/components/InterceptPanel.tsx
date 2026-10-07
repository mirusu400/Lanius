import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';

import { dropFlow, forwardAll, forwardFlow } from '../api/client';
import { addScopeFromUrl } from '../api/client';
import type { FlowSummary, InterceptRules, PausedFlow } from '../api/types';
import { editsFromText, parseRequest, renderPaused, renderPausedVariant, renderRequest } from '../tabs/interceptModel';
import { errorMessage, rawMsg, renderMessage, useT, type Message } from '../i18n';
import { addTab } from '../tabs/replayStore';
import { emptyTab, originOf } from '../tabs/replayModel';
import { sendTextToFuzzer } from '../tabs/fuzzerStore';
import { flowMenuItems, flowUrl } from '../tabs/flowMenu';
import { OpenBrowserButton } from './OpenBrowserButton';
import { MatchReplaceButton } from './MatchReplaceDialog';
import { HighlightedEditor } from './SyntaxCode';
import { ContextMenu, useContextMenu } from './ContextMenu';
import { useCodegenMenu } from './useCodegenMenu';
import { usePluginActions } from './usePluginActions';

interface Props {
  rules: InterceptRules;
  paused: PausedFlow[];
  onToggle: (patch: Partial<InterceptRules>) => void;
  onResolved: (id: string) => void;
  drafts?: Record<string, string>;
  onDraftsChange?: Dispatch<SetStateAction<Record<string, string>>>;
  selectedId?: string | null;
  onSelectedChange?: (id: string | null) => void;
}

interface HeldMenuTarget {
  paused: PausedFlow;
  requestText: string;
}

/** Give the shared history menu the request that is actually shown in Intercept. */
function heldRequest(target: HeldMenuTarget) {
  const { paused, requestText } = target;
  let request: ReturnType<typeof parseRequest>;
  try {
    request = parseRequest(requestText);
  } catch {
    // Keep the menu available while a draft is incomplete. Replay and Fuzzer
    // still receive the raw draft so the user can finish it there.
    request = {
      method: paused.method,
      path: paused.path,
      httpVersion: paused.http_version,
      headers: paused.request_headers,
      body: paused.request_body,
    };
  }
  const flow: FlowSummary = {
    id: paused.id,
    type: 'http',
    client_addr: null,
    server_addr: null,
    scheme: paused.scheme,
    method: request.method,
    host: paused.host,
    port: paused.port,
    path: request.path,
    query: null,
    http_version: request.httpVersion,
    request_size: request.body.length,
    started_at: null,
    status_code: paused.status_code ?? null,
    reason: paused.reason ?? null,
    response_size: paused.response_body?.length ?? 0,
    response_mime: null,
    completed_at: null,
    duration_ms: null,
    error: null,
    source: 'proxy',
    comment: null,
  };
  return { flow, request };
}

export function InterceptPanel({
  rules,
  paused,
  onToggle,
  onResolved,
  drafts: controlledDrafts,
  onDraftsChange,
  selectedId: controlledSelectedId,
  onSelectedChange,
}: Props) {
  const t = useT();
  // Which held request is being shown. Pick from the queue rather than
  // only ever seeing the oldest, which matters once several
  // are waiting and the one you care about is not first.
  const [localSelectedId, setLocalSelectedId] = useState<string | null>(null);
  const selectedId = controlledSelectedId === undefined ? localSelectedId : controlledSelectedId;
  const setSelectedId = onSelectedChange ?? setLocalSelectedId;
  const current =
    paused.find((flow) => flow.id === selectedId) ?? paused[0] ?? null;
  const [localDrafts, setLocalDrafts] = useState<Record<string, string>>({});
  const drafts = controlledDrafts ?? localDrafts;
  const setDrafts = onDraftsChange ?? setLocalDrafts;
  const [stage, setStage] = useState<'original' | 'auto_modified' | 'modified'>('modified');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Message | null>(null);
  const menu = useContextMenu<HeldMenuTarget>();
  const codegen = useCodegenMenu(setError);
  const pluginActions = usePluginActions((message) => setError(rawMsg(message)));
  const automatic = useMemo(
    () => (current ? renderPaused(current) : ''),
    [current],
  );
  const currentKey = current ? `${current.id}:${current.phase}` : null;
  const modified = currentKey ? drafts[currentKey] ?? automatic : '';
  const dirty = modified !== automatic;
  const shown = current && stage !== 'modified'
    ? renderPausedVariant(current, stage)
    : modified;
  const shownMenuFlow = current?.phase === 'request' && stage !== 'modified'
    && current.request_variants?.[stage]
    ? {
        ...current,
        scheme: current.request_variants[stage].scheme,
        host: current.request_variants[stage].host,
        port: current.request_variants[stage].port,
      }
    : current;
  const shownHeaders = current?.phase === 'request'
    ? (stage !== 'modified' ? current.request_variants?.[stage]?.headers : null) ?? current.request_headers
    : (stage !== 'modified' ? current?.response_variants?.[stage]?.headers : null) ?? current?.response_headers ?? [];

  useEffect(() => {
    const keys = new Set(paused.map((flow) => `${flow.id}:${flow.phase}`));
    setDrafts((previous) => {
      if (Object.keys(previous).every((key) => keys.has(key))) return previous;
      return Object.fromEntries(Object.entries(previous).filter(([key]) => keys.has(key)));
    });
  }, [paused, setDrafts]);

  // Follow the queue: when the shown request is forwarded or dropped, fall
  // back to whatever is at the front rather than showing an empty pane.
  useEffect(() => {
    if (selectedId && !paused.some((flow) => flow.id === selectedId)) {
      setSelectedId(null);
    }
  }, [paused, selectedId]);

  const act = async (action: 'forward' | 'drop') => {
    if (!current || busy) return;
    setBusy(true);
    try {
      if (action === 'drop') {
        await dropFlow(current.id);
      } else {
        const edits =
          dirty ? editsFromText(current.phase, modified) : {};
        await forwardFlow(current.id, edits);
      }
      if (currentKey) setDrafts((previous) => {
        const next = { ...previous };
        delete next[currentKey];
        return next;
      });
      onResolved(current.id);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const actAll = async (): Promise<boolean> => {
    if (busy || paused.length === 0) return false;
    // Parse every edited message before releasing any, so a bad draft cannot
    // cause an avoidable half-forwarded queue.
    let pending: { flow: PausedFlow; edits: ReturnType<typeof editsFromText> }[];
    try {
      pending = paused.map((flow) => {
        const text = drafts[`${flow.id}:${flow.phase}`];
        return { flow, edits: text === undefined || text === renderPaused(flow)
          ? {} : editsFromText(flow.phase, text) };
      });
    } catch (err) {
      setError(errorMessage(err));
      return false;
    }
    setBusy(true);
    try {
      if (pending.every(({ edits }) => Object.keys(edits).length === 0)) {
        await forwardAll();
        setDrafts({});
        onResolved('*');
      } else {
        for (const { flow, edits } of pending) {
          await forwardFlow(flow.id, edits);
          const key = `${flow.id}:${flow.phase}`;
          setDrafts((previous) => {
            const next = { ...previous };
            delete next[key];
            return next;
          });
          onResolved(flow.id);
        }
      }
      setError(null);
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const changeDraft = (value: string) => {
    if (!currentKey) return;
    setDrafts((previous) => {
      const next = { ...previous };
      if (value === automatic) delete next[currentKey];
      else next[currentKey] = value;
      return next;
    });
  };

  const moveInQueue = (event: React.KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const button = (event.target as HTMLElement).closest('button');
    if (!button || !event.currentTarget.contains(button)) return;
    const index = paused.findIndex((flow) => flow.id === current?.id);
    const next = Math.max(0, Math.min(paused.length - 1,
      index + (event.key === 'ArrowDown' ? 1 : -1)));
    event.preventDefault();
    setSelectedId(paused[next].id);
    event.currentTarget.querySelectorAll('button')[next]?.focus();
  };

  const menuRequestText = (flow: PausedFlow) =>
    flow.phase === 'request'
      ? drafts[`${flow.id}:${flow.phase}`] ?? renderRequest(flow)
      : renderRequest(flow);
  const openCurrentMenu = (event: React.MouseEvent) => {
    if (!current) return;
    menu.open(event, {
      paused: shownMenuFlow ?? current,
      requestText: current.phase === 'request' ? shown : renderRequest(current),
    });
  };
  const menuTarget = menu.target ? heldRequest(menu.target) : null;
  const menuText = menu.target?.requestText ?? '';

  return (
    <div className="intercept-panel">
      <div className="intercept-controls">
        <OpenBrowserButton />
        <MatchReplaceButton />
        <button
          className={rules.enabled ? 'toggle on' : 'toggle'}
          disabled={busy}
          onClick={() => {
            if (rules.enabled && Object.keys(drafts).length > 0 && paused.length > 0) {
              void actAll().then((succeeded) => {
                if (succeeded) onToggle({ enabled: false });
              });
            } else onToggle({ enabled: !rules.enabled });
          }}
        >
          {rules.enabled ? t('intercept.on') : t('intercept.off')}
        </button>
        <label>
          <input
            type="checkbox"
            checked={rules.intercept_requests}
            onChange={(e) => onToggle({ intercept_requests: e.target.checked })}
          />
          {t('intercept.requests')}
        </label>
        <label>
          <input
            type="checkbox"
            checked={rules.intercept_responses}
            onChange={(e) =>
              onToggle({ intercept_responses: e.target.checked })
            }
          />
          {t('intercept.responses')}
        </label>
        <input
          className="host"
          placeholder={t('intercept.hostFilter')}
          value={rules.host_filter ?? ''}
          onChange={(e) => onToggle({ host_filter: e.target.value })}
        />
        <span className="spacer" />
        <span className="queue">
          {t('intercept.queued', { count: paused.length })}
        </span>
        <button onClick={() => void act('forward')} disabled={!current || busy}>
          {t('intercept.forward')}
        </button>
        <button className="danger" onClick={() => void act('drop')} disabled={!current || busy}>
          {t('intercept.drop')}
        </button>
        <button
          onClick={() => void actAll()}
          disabled={paused.length === 0 || busy}
        >
          {t('intercept.forwardAll')}
        </button>
      </div>
      {error && <div className="banner error">{renderMessage(error, t)}</div>}
      {paused.length > 1 && (
        <ul className="intercept-queue" aria-label={t('intercept.queueLabel')} onKeyDown={moveInQueue}>
          {paused.map((flow) => (
            <li key={flow.id}>
              <button
                type="button"
                className={flow.id === current?.id ? 'active' : undefined}
                aria-current={flow.id === current?.id ? 'true' : undefined}
                onClick={() => setSelectedId(flow.id)}
                onContextMenu={(event) => {
                  setSelectedId(flow.id);
                  menu.open(event, { paused: flow, requestText: menuRequestText(flow) });
                }}
              >
                <span className={`phase phase-${flow.phase}`}>
                  {flow.phase === 'request'
                    ? t('intercept.phaseRequest')
                    : t('intercept.phaseResponse')}
                </span>
                <span className="method mono">{flow.method}</span>
                <span className="target mono" title={`${flow.host}${flow.path}`}>
                  {flow.host}
                  {flow.path}
                </span>
                {flow.status_code != null && (
                  <span className="mono muted">{flow.status_code}</span>
                )}
                {drafts[`${flow.id}:${flow.phase}`] !== undefined && (
                  <span className="intercept-dirty" aria-label={t('intercept.unsaved')}>●</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {current ? (
        <>
          <div className="detail-url mono" onContextMenu={openCurrentMenu}>
            <strong>
              {current.phase === 'request'
                ? t('intercept.waitingRequest')
                : t('intercept.waitingResponse')}
            </strong>{' '}
            {stage !== 'modified' && current.phase === 'request' && current.request_variants?.[stage]
              ? `${current.request_variants[stage].scheme}://${current.request_variants[stage].host}${current.request_variants[stage].path}`
              : `${current.scheme}://${current.host}${current.path}`}
          </div>
          <div className="intercept-versions" role="tablist" aria-label={t('intercept.versions')}>
            {(['original', 'auto_modified', 'modified'] as const).map((option) => (
              <button key={option} type="button" role="tab"
                aria-selected={stage === option}
                className={stage === option ? 'active' : undefined}
                onClick={() => setStage(option)}>
                {t(`intercept.view.${option}`)}
                {option === 'modified' && dirty && <span className="intercept-dirty" aria-label={t('intercept.unsaved')}> •</span>}
              </button>
            ))}
            <span className="spacer" />
            {stage !== 'modified' && <span className="muted">{t('intercept.readOnly')}</span>}
            {dirty && <span className="muted">{t('intercept.forwardUsesModified')}</span>}
          </div>
          <div className="intercept-editor-shell" onContextMenu={openCurrentMenu}>
            <HighlightedEditor
              className="intercept-editor mono"
              text={shown}
              onChange={changeDraft}
              readOnly={stage !== 'modified'}
              label={t('intercept.editor')}
              headers={shownHeaders}
              responsePath={current.path}
            />
          </div>
        </>
      ) : (
        <div className="intercept-idle muted">
          {rules.enabled ? t('intercept.idleOn') : t('intercept.idleOff')}
        </div>
      )}
      <ContextMenu
        position={menu.position}
        items={menu.target && menuTarget ? flowMenuItems(menuTarget.flow, t, {
          sendToReplay: (flow) => {
            addTab({
              ...emptyTab(),
              title: `${flow.method} ${flow.path ?? '/'}`,
              url: originOf(flow),
              text: menuText,
            });
          },
          sendToFuzzer: (flow) => {
            sendTextToFuzzer(originOf(flow), menuText);
          },
          addToScope: (flow) => {
            void addScopeFromUrl(flowUrl(flow)).catch((err: unknown) => setError(errorMessage(err)));
          },
          copy: (text) => { void navigator.clipboard?.writeText(text); },
        }, codegen.buildMenu({
          url: flowUrl(menuTarget.flow),
          method: menuTarget.request.method,
          headers: menuTarget.request.headers,
          body: menuTarget.request.body,
        }), pluginActions.buildMenu(
          ['flow', menu.target.paused.phase],
          { flow_id: menu.target.paused.id, flow: menuTarget.flow },
        )) : []}
        onClose={menu.close}
      />
    </div>
  );
}

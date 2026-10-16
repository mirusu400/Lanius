/** A side panel that reads the selected text through its encodings.
 *
 * Select part of a request or response and the panel shows it decoded:
 * URL encoding, Base64, hex, escapes and the like peeled off, and bytes
 * shown as text in the charset they were written in, rather than as a
 * row of hex. Where the selection is editable, the decoded text can be
 * changed and applied, and is encoded back the same way it came.
 *
 * The decoding happens in the engine, which has every legacy charset;
 * the browser can decode some of them but encode none.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  applyInspect,
  inspectValue,
  type InspectRequest,
  type InspectResult,
} from '../api/client';
import { useT } from '../i18n';
import type { TranslationKey, Translator } from '../i18n';
import {
  INSPECTOR_CHARSETS,
  isFormValue,
  rememberCharset,
  rememberedCharset,
  requestHost,
  systemLocale,
} from './inspectorModel';
import { UndoableTextarea } from './UndoableText';
import type { InspectorSelection } from './useInspector';

const DEBOUNCE_MS = 150;

const REASONS = new Set([
  'bom', 'utf8_valid', 'content_type', 'referer', 'preferred', 'request', 'tld', 'locale', 'manual',
]);

const LAYER_LABELS: Record<string, string> = {
  url: 'URL',
  base64: 'Base64',
  base64url: 'Base64URL',
  hex: 'Hex',
  html: 'HTML',
  unicode_escape: '\\u',
  bytes_escape: '\\x',
  gzip: 'Gzip',
  jwt: 'JWT',
};

function inspectError(t: Translator, error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (text.startsWith('CHARSET_UNENCODABLE:')) {
    const [, charset, ...chars] = text.split(':');
    return t('inspector.unencodable', { charset, char: chars.join(':') });
  }
  if (text === 'INSPECT_TOO_LARGE') return t('inspector.tooLarge');
  if (text === 'JWT_INVALID_JSON') return t('inspector.jwtInvalid');
  if (text === 'NOT_TEXT') return t('inspector.notText');
  return text || t('common.error');
}

export function InspectorPanel({
  selection,
  request,
  onApply,
  onEditInReplay,
}: {
  selection: InspectorSelection | null;
  /** The raw request, for the charset hints it carries. */
  request: string;
  /** Present when the selection can be replaced. Returns false when the
   * text it came from has changed since it was selected. */
  onApply?: (selection: InspectorSelection, value: string) => boolean;
  /** Offered instead of Apply where the message cannot be edited. */
  onEditInReplay?: () => void;
}) {
  const t = useT();
  const text = selection?.text ?? '';
  const start = selection?.start;

  // Each piece of state remembers the selection it belongs to, so a new
  // selection starts clean without an effect having to reset anything.
  const [choice, setChoice] = useState({ text: '', charset: '' });
  const charset = choice.text === text ? choice.charset : '';
  const [inspected, setInspected] = useState<{
    text: string;
    result: InspectResult | null;
    error: string | null;
  } | null>(null);
  const current = text && inspected?.text === text ? inspected : null;
  const result = current?.result ?? null;
  const [draftState, setDraftState] = useState<{ result: InspectResult | null; value: string }>({
    result: null,
    value: '',
  });
  const draft = draftState.result === result ? draftState.value : result?.text ?? '';
  const setDraft = (value: string) => setDraftState({ result, value });
  const [applyError, setApplyError] = useState<{ text: string; message: string } | null>(null);
  const error = applyError?.text === text ? applyError.message : current?.error ?? null;
  const [busy, setBusy] = useState(false);

  // Read when the request is sent, not tracked: typing elsewhere in the
  // request must not re-run the inspection and throw away an edit here.
  const requestRef = useRef(request);
  useLayoutEffect(() => {
    requestRef.current = request;
  }, [request]);
  const host = requestHost(request);

  const context = useCallback((value: string, at?: number): InspectRequest => {
    const raw = requestRef.current;
    return {
      value,
      request: raw,
      form: isFormValue(raw, value, at),
      locale: systemLocale(),
      preferred: rememberedCharset(requestHost(raw)),
    };
  }, []);

  useEffect(() => {
    if (!text) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      inspectValue({ ...context(text, start), charset: charset || null })
        .then((next) => {
          if (!cancelled) setInspected({ text, result: next, error: null });
        })
        .catch((err: unknown) => {
          if (!cancelled) setInspected({ text, result: null, error: inspectError(t, err) });
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [text, start, charset, context, t]);

  const chooseCharset = (value: string) => {
    setChoice({ text, charset: value });
    // Remembered per host: a site that uses one legacy charset uses it
    // everywhere, and the next value should not need the same correction.
    rememberCharset(host, value || null);
  };

  const canEdit = Boolean(onApply && selection && result?.editable);
  const changed = result?.text != null && draft !== result.text;

  const apply = async () => {
    if (!selection || !onApply || !changed) return;
    setBusy(true);
    try {
      const { value } = await applyInspect({
        ...context(selection.text, selection.start),
        charset: result?.charset?.name ?? null,
        text: draft,
      });
      if (onApply(selection, value)) setApplyError(null);
      else setApplyError({ text: selection.text, message: t('inspector.stale') });
    } catch (err) {
      setApplyError({ text: selection.text, message: inspectError(t, err) });
    } finally {
      setBusy(false);
    }
  };

  const detected = result?.charset ?? null;
  const offered = detected
    ? [
        ...detected.candidates.map((c) => [c.name, `${c.label} — ${c.text.slice(0, 24)}`] as const),
        ...INSPECTOR_CHARSETS.filter(([name]) => !detected.candidates.some((c) => c.name === name)),
      ]
    : [];

  return (
    <aside className="inspector" aria-label={t('inspector.title')}>
      <div className="inspector-bar">
        <span className="inspector-title">{t('inspector.title')}</span>
      </div>
      <div className="inspector-body">
        {!selection && <p className="muted">{t('inspector.empty')}</p>}

        {selection && (
          <>
            <h4>{t('inspector.selected')}</h4>
            <pre className="inspector-original mono">{selection.text}</pre>
          </>
        )}

        {result && result.layers.length > 0 && (
          <div className="inspector-layers" aria-label={t('inspector.layers')}>
            {result.layers.map((layer, index) => (
              <span key={index} className="inspector-layer">
                {index > 0 && <span className="muted" aria-hidden="true">→ </span>}
                <span className="pill">
                  {layer.kind === 'charset' ? layer.label : LAYER_LABELS[layer.kind] ?? layer.kind}
                </span>
              </span>
            ))}
          </div>
        )}

        {detected && (
          <div className="inspector-charset">
            <label>
              <span>{t('inspector.charset')}</span>
              <select
                aria-label={t('inspector.charset')}
                value={charset}
                onChange={(event) => chooseCharset(event.target.value)}
              >
                <option value="">{t('inspector.charsetAuto', { charset: detected.label })}</option>
                {offered.map(([name, label]) => (
                  <option key={name} value={name}>{label}</option>
                ))}
              </select>
            </label>
            <span className={`pill confidence-${detected.confidence}`}>
              {t(`inspector.confidence.${detected.confidence}`)}
            </span>
            {detected.reasons.length > 0 && (
              <span className="muted inspector-reasons">
                {detected.reasons
                  .filter((reason) => REASONS.has(reason.code))
                  .map((reason) => t(
                    `inspector.reason.${reason.code}` as TranslationKey,
                    { detail: reason.detail ?? '' },
                  ))
                  .join(' · ')}
              </span>
            )}
          </div>
        )}

        {result && result.text != null && (
          <>
            <h4>{t('inspector.decoded')}</h4>
            <UndoableTextarea
              className="inspector-decoded mono"
              aria-label={t('inspector.decoded')}
              historyKey={selection?.text}
              value={draft}
              readOnly={!canEdit}
              onValueChange={setDraft}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void apply();
                }
              }}
            />
            {result.layers.length === 0 && <p className="muted">{t('inspector.plain')}</p>}
          </>
        )}

        {result && result.text == null && result.hex && (
          <>
            <h4>{t('inspector.binary')}</h4>
            <pre className="inspector-hex mono">{result.hex}</pre>
          </>
        )}

        {error && <div className="banner error">{error}</div>}

        {result && result.text != null && result.layers.length > 0 && (
          <div className="inspector-actions">
            {onApply ? (
              <>
                <button type="button" onClick={() => setDraft(result.text ?? '')} disabled={!changed || busy}>
                  {t('common.reset')}
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => void apply()}
                  disabled={!canEdit || !changed || busy}
                  title={t('inspector.applyShortcut')}
                >
                  {t('inspector.apply')}
                </button>
              </>
            ) : onEditInReplay ? (
              <>
                <span className="muted">{t('inspector.readOnly')}</span>
                <button type="button" onClick={onEditInReplay}>{t('inspector.editInReplay')}</button>
              </>
            ) : null}
          </div>
        )}
      </div>
    </aside>
  );
}

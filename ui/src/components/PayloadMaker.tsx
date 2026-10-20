import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { errorMessage, renderMessage, useT, type Message } from '../i18n';
import type { TranslationKey } from '../i18n/catalogue';
import { Dialog } from './Dialog';
import { Split } from './Split';
import { UndoableInput } from './UndoableText';
import {
  PAYLOAD_DATE_FORMATS, PAYLOAD_OPERATIONS, previewPayloads,
  type PayloadMakerConfig, type PayloadOperation, type PayloadSource, type PayloadStep,
} from './payloadMakerModel';
import { parsePayloads } from '../tabs/fuzzerModel';

interface Props {
  open: boolean;
  value: string;
  onClose: () => void;
  onUse: (text: string) => void;
  requestCount?: (count: number) => number;
}

export function PayloadMaker({ open, value, onClose, onUse, requestCount }: Props) {
  const t = useT();
  const sectionId = useId();
  const [sourceKind, setSourceKind] = useState<PayloadSource['kind']>('numbers');
  const [numbers, setNumbers] = useState({ start: '0', end: '9999', step: '1', padding: '0' });
  const [characters, setCharacters] = useState({ alphabet: 'abcdefghijklmnopqrstuvwxyz', minLength: '1', maxLength: '2' });
  const [dates, setDates] = useState(() => {
    const year = String(new Date().getFullYear()).padStart(4, '0');
    return { start: `${year}-01-01`, end: `${year}-12-31`, step: '1', format: 'YYYY-MM-DD' };
  });
  const [steps, setSteps] = useState<(PayloadStep & { id: number })[]>([]);
  const nextId = useRef(0);
  const worker = useRef<Worker | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ config: PayloadMakerConfig; message: Message } | null>(null);
  const config = useMemo<PayloadMakerConfig>(() => ({
    source: sourceKind === 'numbers' ? { kind: 'numbers', ...numbers }
      : sourceKind === 'characters' ? { kind: 'characters', ...characters }
        : sourceKind === 'dates' ? { kind: 'dates', ...dates }
          : { kind: 'existing', text: value },
    steps,
  }), [sourceKind, numbers, characters, dates, value, steps]);
  const inspection = useMemo(() => {
    if (!open) return null;
    try { return { preview: previewPayloads(config), error: null }; }
    catch (error) { return { preview: null, error: errorMessage(error) }; }
  }, [open, config]);
  const preview = inspection?.preview;
  const error = failure?.config === config ? failure.message : inspection?.error;
  const allowed = !!preview && !preview.overLimit && !busy;
  const existingCount = useMemo(() => open ? parsePayloads(value).length : 0, [open, value]);

  useEffect(() => () => { worker.current?.terminate(); }, []);

  const close = () => {
    worker.current?.terminate();
    worker.current = null;
    setBusy(false);
    setFailure(null);
    onClose();
  };
  const generate = (append: boolean) => {
    if (!allowed) return;
    setFailure(null);
    setBusy(true);
    const fail = (message: Message) => {
      worker.current?.terminate();
      worker.current = null;
      setBusy(false);
      setFailure({ config, message });
    };
    try {
      const task = new Worker(new URL('./payloadMaker.worker.ts', import.meta.url), { type: 'module' });
      worker.current = task;
      task.onmessage = (event: MessageEvent<{ text?: string; error?: TranslationKey }>) => {
        if (worker.current !== task) return;
        if (event.data.error) { fail({ kind: 'key', key: event.data.error }); return; }
        if (typeof event.data.text !== 'string') { fail({ kind: 'key', key: 'payloadMaker.failed' }); return; }
        onUse(event.data.text);
        close();
      };
      task.onerror = (event) => {
        event.preventDefault();
        if (worker.current === task) fail({ kind: 'key', key: 'payloadMaker.failed' });
      };
      task.postMessage({ config, appendTo: append ? value : undefined });
    } catch { fail({ kind: 'key', key: 'payloadMaker.failed' }); }
  };
  const patchStep = (id: number, patch: Partial<PayloadStep>) => {
    setSteps((current) => current.map((step) => step.id === id ? { ...step, ...patch } : step));
  };
  const moveStep = (index: number, delta: number) => {
    setSteps((current) => {
      const next = [...current];
      [next[index], next[index + delta]] = [next[index + delta], next[index]];
      return next;
    });
  };

  return <Dialog
    open={open}
    title={t('payloadMaker.title')}
    onClose={close}
    className="payload-maker-dialog"
    footer={<>
      <span className="muted" role="status">{busy ? t('payloadMaker.generating') : ''}</span>
      <span className="spacer" />
      <button type="button" onClick={close}>{t('common.cancel')}</button>
      <button type="button" disabled={!allowed}
        onClick={() => generate(true)}>{t('payloadMaker.appendSet')}</button>
      <button type="button" className="send" disabled={!allowed} onClick={() => generate(false)}>{t('payloadMaker.replaceSet')}</button>
    </>}
  >
    {open && <>
      {error && <div className="banner error" role="alert">{renderMessage(error, t)}</div>}
      {preview?.overLimit && <div className="banner error" role="alert">{t('payloadMaker.limitCount')}</div>}
      <Split
        direction="horizontal"
        storageKey="lanius.split.payloadMaker"
        initial={0.52}
        className="payload-maker-body"
        first={<div className="payload-maker-settings">
          <fieldset disabled={busy} aria-labelledby={`${sectionId}-source`}>
            <div className="payload-maker-section-head">
              <span className="payload-maker-section-number" aria-hidden="true">01</span>
              <h4 id={`${sectionId}-source`}>{t('payloadMaker.source')}</h4>
            </div>
            <select className="payload-maker-source-select" aria-label={t('payloadMaker.source')} value={sourceKind}
              onChange={(event) => setSourceKind(event.target.value as PayloadSource['kind'])}>
              {(['numbers', 'characters', 'dates', 'existing'] as const).map((kind) =>
                <option key={kind} value={kind}>{t(`payloadMaker.${kind}`)}</option>)}
            </select>
            {sourceKind === 'numbers' && <>
              <div className="payload-maker-fields">
                {(['start', 'end', 'step', 'padding'] as const).map((field) => <label key={field}>
                  {t(`payloadMaker.${field}`)}
                  <UndoableInput value={numbers[field]} inputMode="numeric" maxLength={65}
                    onValueChange={(next) => setNumbers((current) => ({ ...current, [field]: next }))} />
                </label>)}
              </div>
            </>}
            {sourceKind === 'characters' && <>
              <label>{t('payloadMaker.alphabet')}
                <UndoableInput value={characters.alphabet} maxLength={512}
                  onValueChange={(alphabet) => setCharacters((current) => ({ ...current, alphabet }))} />
              </label>
              <div className="payload-maker-alphabets">
                {['abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '0123456789'].map((alphabet, index) =>
                  <button type="button" key={alphabet} onClick={() => setCharacters((current) => ({ ...current, alphabet }))}>
                    {['a–z', 'A–Z', '0–9'][index]}
                  </button>)}
              </div>
              <div className="payload-maker-fields">
                {(['minLength', 'maxLength'] as const).map((field) => <label key={field}>
                  {t(`payloadMaker.${field}`)}
                  <UndoableInput value={characters[field]} inputMode="numeric" maxLength={2}
                    onValueChange={(next) => setCharacters((current) => ({ ...current, [field]: next }))} />
                </label>)}
              </div>
            </>}
            {sourceKind === 'existing' && <>
              <textarea readOnly className="mono" aria-label={t('payloadMaker.existing')} value={value} />
            </>}
            {sourceKind === 'dates' && <div className="payload-maker-fields">
              {(['start', 'end'] as const).map((field) => <label key={field}>
                {t(field === 'start' ? 'payloadMaker.dateStart' : 'payloadMaker.dateEnd')}
                <UndoableInput type="date" min="0001-01-01" max="9999-12-31" value={dates[field]}
                  onValueChange={(next) => setDates((current) => ({ ...current, [field]: next }))} />
              </label>)}
              <label>{t('payloadMaker.dateStep')}
                <UndoableInput value={dates.step} inputMode="numeric" maxLength={64}
                  onValueChange={(step) => setDates((current) => ({ ...current, step }))} />
              </label>
              <label>{t('payloadMaker.dateFormat')}
                <select value={dates.format} onChange={(event) => setDates((current) => ({ ...current, format: event.target.value }))}>
                  {PAYLOAD_DATE_FORMATS.map((format) => <option key={format} value={format}>{format}</option>)}
                </select>
              </label>
            </div>}
          </fieldset>
          <fieldset disabled={busy} aria-labelledby={`${sectionId}-processing`}>
            <div className="payload-maker-section-head">
              <span className="payload-maker-section-number" aria-hidden="true">02</span>
              <h4 id={`${sectionId}-processing`}>{t('payloadMaker.processing')}</h4>
              <span className="payload-maker-optional">{t('payloadMaker.optional')}</span>
            </div>
            {steps.length === 0 && <p className="payload-maker-empty">{t('payloadMaker.processingEmpty')}</p>}
            <ol className="payload-maker-steps">
              {steps.map((step, index) => <li key={step.id}>
                <div className="payload-maker-step-head">
                  <span className="muted">{index + 1}.</span>
                  <select aria-label={t('payloadMaker.operation', { index: index + 1 })} value={step.kind}
                    onChange={(event) => patchStep(step.id, { kind: event.target.value as PayloadOperation, omitPadding: event.target.value === 'base64url' })}>
                    {PAYLOAD_OPERATIONS.map((kind) => <option key={kind} value={kind}>{t(`payloadMaker.${kind}`)}</option>)}
                  </select>
                  <button type="button" aria-label={t('payloadMaker.moveUp', { index: index + 1 })} disabled={index === 0} onClick={() => moveStep(index, -1)}>↑</button>
                  <button type="button" aria-label={t('payloadMaker.moveDown', { index: index + 1 })} disabled={index === steps.length - 1} onClick={() => moveStep(index, 1)}>↓</button>
                  <button type="button" aria-label={t('payloadMaker.removeStep', { index: index + 1 })} onClick={() => setSteps((current) => current.filter((entry) => entry.id !== step.id))}>×</button>
                </div>
                {(step.kind === 'prefix' || step.kind === 'suffix' || step.kind === 'replace') && <label>
                  {t(step.kind === 'replace' ? 'payloadMaker.search' : 'payloadMaker.text', { index: index + 1 })}
                  <UndoableInput value={step.value} maxLength={4096} onValueChange={(next) => patchStep(step.id, { value: next })} />
                </label>}
                {step.kind === 'replace' && <label>
                  {t('payloadMaker.replacement', { index: index + 1 })}
                  <UndoableInput value={step.replacement} maxLength={4096} onValueChange={(next) => patchStep(step.id, { replacement: next })} />
                </label>}
                {(step.kind === 'base64' || step.kind === 'base64url') && <label className="payload-maker-checkbox">
                  <input type="checkbox" checked={step.omitPadding} onChange={(event) => patchStep(step.id, { omitPadding: event.target.checked })} />
                  {t('payloadMaker.omitPadding')}
                </label>}
              </li>)}
            </ol>
            <button type="button" className="payload-maker-add-step" disabled={steps.length >= 20} onClick={() => {
              const id = nextId.current++;
              setSteps((current) => [...current, { id, kind: 'prefix', value: '', replacement: '', omitPadding: false }]);
            }}><span aria-hidden="true">＋</span> {t('payloadMaker.addStep')}</button>
          </fieldset>
          <details className="payload-maker-help">
            <summary>{t('payloadMaker.help')}</summary>
            <p>{t(sourceKind === 'numbers' ? 'payloadMaker.numberHint' : sourceKind === 'characters' ? 'payloadMaker.characterHint' : sourceKind === 'dates' ? 'payloadMaker.dateHint' : 'payloadMaker.existingHint')}</p>
            <p>{t('payloadMaker.processingHint')}</p>
            <p>{t('payloadMaker.limits')}</p>
            {preview && <p>{t('payloadMaker.previewHint', { shown: preview.rows.length, count: preview.count.toLocaleString() })}</p>}
          </details>
        </div>}
        second={<section className="payload-maker-preview" aria-label={t('payloadMaker.preview')} aria-busy={busy}>
          <div className="payload-maker-section-head">
            <span className="payload-maker-section-number" aria-hidden="true">03</span>
            <h4>{t('payloadMaker.preview')}</h4>
            {preview && <span className="payload-maker-count">{t('payloads.count', { count: preview.count.toLocaleString() })}</span>}
          </div>
          {preview && <>
            <div className="payload-maker-preview-table">
              <table className="flow-table">
                <thead><tr><th>{t('payloadMaker.original')}</th><th>{t('payloadMaker.result')}</th></tr></thead>
                <tbody>{preview.rows.map((row, index) => <tr key={index}>
                  <td className="mono">{shortPreview(row.original)}</td>
                  <td className={row.result === null ? 'muted' : 'mono'}>{row.result === null ? t('payloadMaker.removed') : shortPreview(row.result)}</td>
                </tr>)}</tbody>
              </table>
            </div>
            <div className="payload-maker-preview-foot">
              <span className="muted">{t('payloadMaker.sample', { count: preview.rows.length })}</span>
              {requestCount && !preview.overLimit && <details className="payload-maker-estimates">
                <summary>{t('payloadMaker.requestEstimates')}</summary>
                <p>{t('payloadMaker.requests', { count: requestCount(Number(preview.count)).toLocaleString() })}</p>
                <p>{t('payloadMaker.appendRequests', { count: requestCount(Number(preview.count) + existingCount).toLocaleString() })}</p>
              </details>}
            </div>
          </>}
        </section>}
      />
    </>}
  </Dialog>;
}

function shortPreview(value: string): string {
  return value.length > 256 ? `${value.slice(0, 256)}…` : value;
}

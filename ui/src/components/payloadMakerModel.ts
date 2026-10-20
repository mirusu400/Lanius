/** Local payload generation. Preview and worker use the same ordered pipeline. */
import { ParseError } from '../i18n/ParseError';

export const MAX_MAKER_PAYLOADS = 100_000;
export const MAX_MAKER_BYTES = 8 * 1024 * 1024;
export const MAKER_PREVIEW_ROWS = 100;
const MAX_VALUE_LENGTH = 65_536;
const encoder = new TextEncoder();
const DAY_MS = 86_400_000;
export const PAYLOAD_DATE_FORMATS = ['YYYY-MM-DD', 'YYYYMMDD', 'YYMMDD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'MMDD'] as const;

export type PayloadSource =
  | { kind: 'numbers'; start: string; end: string; step: string; padding: string }
  | { kind: 'characters'; alphabet: string; minLength: string; maxLength: string }
  | { kind: 'dates'; start: string; end: string; step: string; format: string }
  | { kind: 'existing'; text: string };

export const PAYLOAD_OPERATIONS = [
  'prefix', 'suffix', 'url', 'form', 'base64', 'base64url',
  'uppercase', 'lowercase', 'replace', 'deduplicate',
] as const;
export type PayloadOperation = typeof PAYLOAD_OPERATIONS[number];
export interface PayloadStep {
  kind: PayloadOperation;
  value: string;
  replacement: string;
  omitPadding: boolean;
}
export interface PayloadMakerConfig {
  source: PayloadSource;
  steps: PayloadStep[];
}
export interface PayloadPreviewRow { original: string; result: string | null }

function integer(text: string): bigint {
  if (!/^-?\d{1,64}$/.test(text)) throw new ParseError('payloadMaker.invalidInteger');
  return BigInt(text);
}

function boundedInteger(text: string, min: number, max: number): number {
  const value = integer(text);
  if (value < min || value > max) throw new ParseError('payloadMaker.invalidLength');
  return Number(value);
}

function* existingLines(text: string): Generator<string> {
  let start = 0;
  while (start <= text.length) {
    const end = text.indexOf('\n', start);
    // Match the Fuzzer's current one-line, trimmed, non-empty payload format.
    const line = text.slice(start, end < 0 ? undefined : end).trim();
    if (line) yield line;
    if (end < 0) break;
    start = end + 1;
  }
}

function calendarDate(text: string): number {
  if (!/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(text)) throw new ParseError('payloadMaker.invalidDate');
  const time = Date.parse(`${text}T00:00:00Z`);
  // Date parsing can roll February 30 into March; require an exact round trip.
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== text) {
    throw new ParseError('payloadMaker.invalidDate');
  }
  return time;
}

function formattedDate(time: number, format: string): string {
  const iso = new Date(time).toISOString().slice(0, 10);
  const parts: Record<string, string> = { YYYY: iso.slice(0, 4), YY: iso.slice(2, 4), MM: iso.slice(5, 7), DD: iso.slice(8, 10) };
  return format.replace(/YYYY|YY|MM|DD/g, (token) => parts[token]);
}

function sourcePlan(source: PayloadSource): { count: bigint; values: () => Generator<string> } {
  if (source.kind === 'dates') {
    const start = calendarDate(source.start);
    const end = calendarDate(source.end);
    const step = integer(source.step);
    if (step <= 0n) throw new ParseError('payloadMaker.invalidStep');
    if (!(PAYLOAD_DATE_FORMATS as readonly string[]).includes(source.format)) {
      throw new ParseError('payloadMaker.invalidDateFormat');
    }
    const distance = BigInt(Math.abs(end - start) / DAY_MS);
    const count = distance / step + 1n;
    // A step beyond the range produces only the start. Avoid converting huge
    // user-entered integers to Number; all useful steps fit within 9999 years.
    const delta = step > distance ? 0 : Number(step) * DAY_MS * (end >= start ? 1 : -1);
    return {
      count,
      values: function* () {
        // UTC calendar days keep DST and the machine's timezone out of ranges.
        for (let index = 0; index < Number(count); index++) yield formattedDate(start + index * delta, source.format);
      },
    };
  }
  if (source.kind === 'numbers') {
    const start = integer(source.start);
    const end = integer(source.end);
    const step = integer(source.step);
    const padding = boundedInteger(source.padding, 0, 64);
    if (step <= 0n) throw new ParseError('payloadMaker.invalidStep');
    const distance = end >= start ? end - start : start - end;
    return {
      count: distance / step + 1n,
      values: function* () {
        const delta = end >= start ? step : -step;
        for (let n = start; delta > 0n ? n <= end : n >= end; n += delta) {
          const negative = n < 0n;
          const digits = (negative ? -n : n).toString().padStart(padding, '0');
          yield `${negative ? '-' : ''}${digits}`;
        }
      },
    };
  }
  if (source.kind === 'characters') {
    // Iterate code points, so a Unicode symbol is one alphabet entry.
    const alphabet = [...new Set([...source.alphabet])];
    if (!alphabet.length || alphabet.length > 128 || /[\r\n]/.test(source.alphabet)) {
      throw new ParseError('payloadMaker.invalidAlphabet');
    }
    const min = boundedInteger(source.minLength, 1, 32);
    const max = boundedInteger(source.maxLength, 1, 32);
    if (min > max) throw new ParseError('payloadMaker.invalidLength');
    let count = 0n;
    for (let length = min; length <= max; length++) count += BigInt(alphabet.length) ** BigInt(length);
    return {
      count,
      values: function* () {
        for (let length = min; length <= max; length++) {
          const indexes = Array<number>(length).fill(0);
          while (true) {
            yield indexes.map((index) => alphabet[index]).join('');
            let position = length - 1;
            while (position >= 0 && indexes[position] === alphabet.length - 1) indexes[position--] = 0;
            if (position < 0) break;
            indexes[position]++;
          }
        }
      },
    };
  }
  checkTextSize(source.text);
  let count = 0n;
  for (const _line of existingLines(source.text)) count++;
  if (!count) throw new ParseError('payloadMaker.emptySource');
  return { count, values: () => existingLines(source.text) };
}

function checkTextSize(text: string): void {
  if (text.length > MAX_MAKER_BYTES || encoder.encode(text).length > MAX_MAKER_BYTES) {
    throw new ParseError('payloadMaker.limitBytes');
  }
}

function validateSteps(steps: PayloadStep[]): void {
  if (steps.length > 20) throw new ParseError('payloadMaker.limitSteps');
  for (const step of steps) {
    if (step.value.length > 4096 || step.replacement.length > 4096) {
      throw new ParseError('payloadMaker.limitValue');
    }
    if (step.kind === 'replace' && !step.value) throw new ParseError('payloadMaker.emptySearch');
  }
}

function pipeline(steps: PayloadStep[]): (value: string) => string | null {
  validateSteps(steps);
  const seen = steps.map(() => new Set<string>());
  let seenBytes = 0;
  return (input) => {
    let value = input;
    if (value.length > MAX_VALUE_LENGTH) throw new ParseError('payloadMaker.limitValue');
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index];
      switch (step.kind) {
        case 'prefix': value = step.value + value; break;
        case 'suffix': value += step.value; break;
        case 'uppercase': value = value.toUpperCase(); break;
        case 'lowercase': value = value.toLowerCase(); break;
        case 'replace': {
          // Bound expanding replacements before allocating their result.
          let length = value.length;
          if (step.replacement.length > step.value.length) {
            for (let at = value.indexOf(step.value); at >= 0; at = value.indexOf(step.value, at + step.value.length)) {
              length += step.replacement.length - step.value.length;
              if (length > MAX_VALUE_LENGTH) throw new ParseError('payloadMaker.limitValue');
            }
          }
          value = value.replaceAll(step.value, () => step.replacement);
          break;
        }
        case 'url':
          // Encode one URL component, including RFC 3986 reserved punctuation.
          value = encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
          break;
        case 'form': value = new URLSearchParams({ p: value }).toString().slice(2); break;
        case 'base64':
        case 'base64url': {
          const bytes = encoder.encode(value);
          value = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
          if (step.kind === 'base64url') value = value.replaceAll('+', '-').replaceAll('/', '_');
          if (step.omitPadding) value = value.replace(/=+$/, '');
          break;
        }
        case 'deduplicate':
          if (seen[index].has(value)) return null;
          seenBytes += encoder.encode(value).length;
          if (seenBytes > MAX_MAKER_BYTES) throw new ParseError('payloadMaker.limitBytes');
          seen[index].add(value);
          break;
      }
      if (value.length > MAX_VALUE_LENGTH) throw new ParseError('payloadMaker.limitValue');
    }
    // Never preview bytes that the line-based Fuzzer would silently change.
    if (!value || value !== value.trim() || /[\r\n]/.test(value)) {
      throw new ParseError('payloadMaker.invalidOutput');
    }
    if (value.length > MAX_VALUE_LENGTH) throw new ParseError('payloadMaker.limitValue');
    return value;
  };
}

export function previewPayloads(config: PayloadMakerConfig) {
  const plan = sourcePlan(config.source);
  const transform = pipeline(config.steps);
  const rows: PayloadPreviewRow[] = [];
  for (const original of plan.values()) {
    rows.push({ original, result: transform(original) });
    if (rows.length >= MAKER_PREVIEW_ROWS) break;
  }
  return { count: plan.count, rows, overLimit: plan.count > MAX_MAKER_PAYLOADS };
}

/** Called in a worker. Limits include existing entries when appending. */
export function generatePayloads(config: PayloadMakerConfig, appendTo?: string): string {
  const plan = sourcePlan(config.source);
  if (plan.count > MAX_MAKER_PAYLOADS) throw new ParseError('payloadMaker.limitCount');
  const transform = pipeline(config.steps);
  const values: string[] = [];
  let count = 0;
  let bytes = 0;
  let prefix = '';
  if (appendTo) {
    checkTextSize(appendTo);
    prefix = appendTo + (appendTo.endsWith('\n') ? '' : '\n');
    bytes = encoder.encode(prefix).length;
    for (const _line of existingLines(appendTo)) count++;
    if (count > MAX_MAKER_PAYLOADS) throw new ParseError('payloadMaker.limitCount');
  }
  const append = (value: string) => {
    count++;
    if (count > MAX_MAKER_PAYLOADS) throw new ParseError('payloadMaker.limitCount');
    bytes += encoder.encode(value).length + (values.length > 0 ? 1 : 0);
    if (bytes > MAX_MAKER_BYTES) throw new ParseError('payloadMaker.limitBytes');
    values.push(value);
  };
  let generated = 0;
  for (const original of plan.values()) {
    const value = transform(original);
    if (value !== null) { append(value); generated++; }
  }
  if (!generated) throw new ParseError('payloadMaker.emptyResult');
  return prefix + values.join('\n');
}

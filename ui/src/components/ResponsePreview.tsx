import { useEffect, useMemo, useRef, useState } from 'react';

import { getResponsePreview } from '../api/client';
import type { ResponsePreview as PreviewData } from '../api/types';
import { useT } from '../i18n';
import { ImagePreview } from './ImagePreview';
import { matchCount } from './searchHighlight';
import { MarkedText } from './MarkedText';
import { markHtmlPreview } from './htmlPreviewSearch';

const PREVIEW_CSP = "default-src 'none'; script-src 'none'; connect-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; navigate-to 'none'";
const NOOP_MATCH_COUNT = () => {};

function asBlobUrl(data: string, mime: string): string {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

function columnIndex(ref: string): number {
  const match = /^[A-Z]+/.exec(ref.toUpperCase());
  if (!match) return -1;
  let index = 0;
  for (const letter of match[0]) index = index * 26 + letter.charCodeAt(0) - 64;
  return index - 1;
}

function columnName(index: number): string {
  let remaining = index + 1;
  let name = '';
  while (remaining > 0) {
    remaining -= 1;
    name = String.fromCharCode(65 + remaining % 26) + name;
    remaining = Math.floor(remaining / 26);
  }
  return name;
}

type GridRows = { number: string; cells: { ref: string; value: string }[] }[];

function gridMatchCount(rows: GridRows, query: string): number {
  return rows.reduce((total, row) => {
    const visible = new Map(row.cells.map((cell) => [columnIndex(cell.ref), cell.value]));
    return total + [...visible].reduce((count, [column, value]) =>
      count + (column >= 0 && column < 50 ? matchCount(value, query) : 0), 0);
  }, 0);
}

function Grid({ rows, query, activeIndex, offset = 0 }: { rows: GridRows; query: string; activeIndex: number | null; offset?: number }) {
  const columns = Math.min(50, Math.max(1, ...rows.flatMap((row) => row.cells.map((cell) => columnIndex(cell.ref) + 1))));
  let nextOffset = offset;
  const preparedRows: { number: string; cells: { value: string; offset: number }[] }[] = [];
  for (const row of rows) {
    const byColumn = new Map(row.cells.map((cell) => [columnIndex(cell.ref), cell.value]));
    const preparedCells: { value: string; offset: number }[] = [];
    for (let i = 0; i < columns; i += 1) {
      const value = byColumn.get(i) || '';
      preparedCells.push({ value, offset: nextOffset });
      nextOffset += matchCount(value, query);
    }
    preparedRows.push({ number: row.number, cells: preparedCells });
  }
  return (
    <div className="preview-grid-scroll">
      <table className="preview-grid">
        <thead><tr><th aria-label="Row" />{Array.from({ length: columns }, (_, i) => <th key={i}>{columnName(i)}</th>)}</tr></thead>
        <tbody>
          {preparedRows.map((row, index) => {
            return (
              <tr key={`${row.number}-${index}`}>
                <th>{row.number || index + 1}</th>
                {row.cells.map(({ value, offset: cellOffset }, i) => <td key={i} title={value}><MarkedText text={value} query={query} activeIndex={activeIndex} offset={cellOffset} /></td>)}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PdfPreview({ data }: { data: string }) {
  const t = useT();
  const frame = useRef<HTMLIFrameElement>(null);
  const download = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    const url = asBlobUrl(data, 'application/pdf');
    if (frame.current) frame.current.src = url;
    if (download.current) download.current.href = url;
    return () => URL.revokeObjectURL(url);
  }, [data]);

  return <div className="response-preview-pdf"><iframe ref={frame} title={t('detail.preview.pdfTitle')} /><a ref={download} download="response.pdf">{t('detail.preview.downloadPdf')}</a></div>;
}

function PreviewContent({ preview, query, activeIndex, onMatchCount }: {
  preview: PreviewData;
  query: string;
  activeIndex: number | null;
  onMatchCount: (count: number) => void;
}) {
  const t = useT();
  const [selected, setSelected] = useState(0);
  const markedHtml = useMemo(() => preview.kind === 'html'
    ? markHtmlPreview(preview.text, query, activeIndex)
    : null, [preview, query, activeIndex]);
  const count = (() => {
    if (preview.kind === 'html') return markedHtml?.count || 0;
    if (preview.kind === 'text') return matchCount(preview.text, query);
    if (preview.kind === 'csv') return preview.rows.reduce((sum, row) => sum + row.slice(0, 50).reduce((n, cell) => n + matchCount(cell, query), 0), 0);
    if (preview.kind === 'spreadsheet') return gridMatchCount(preview.sheets[Math.min(selected, preview.sheets.length - 1)]?.rows || [], query);
    if (preview.kind === 'archive') return preview.entries.reduce((sum, entry) => sum + matchCount(entry.name, query), 0)
      + matchCount(preview.entries[Math.min(selected, preview.entries.length - 1)]?.text || '', query);
    return 0;
  })();
  useEffect(() => onMatchCount(count), [count, onMatchCount]);

  if (preview.kind === 'unavailable') {
    const key = `detail.preview.${preview.reason}` as Parameters<typeof t>[0];
    return <p className="muted">{t(key)}</p>;
  }
  if (preview.kind === 'html') {
    // Captured pages are untrusted. The frame has an opaque origin, no script
    // permission, and a CSP that rejects network loads and form submissions.
    const srcDoc = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><style>mark[data-find-index]{background:#ffe36e;color:#17212d}mark.find-current{background:#ff944d;outline:2px solid #b54400;scroll-margin:24px}</style></head><body>${markedHtml?.html || preview.text}</body></html>`;
    const snippet = activeIndex === null ? null : markedHtml?.snippets[activeIndex];
    return <div className="response-preview-html"><p className="response-preview-note muted">{t('detail.preview.htmlSafety')}</p>
      {snippet && <p className="response-preview-find-snippet mono">{snippet.before}<mark className="find-current">{snippet.match}</mark>{snippet.after}</p>}
      <iframe className="response-preview-frame" title={t('detail.preview.htmlTitle')} sandbox="" referrerPolicy="no-referrer" srcDoc={srcDoc} /></div>;
  }
  if (preview.kind === 'image') {
    return <ImagePreview mime={preview.mime} data={preview.data} />;
  }
  if (preview.kind === 'pdf') {
    return <PdfPreview data={preview.data} />;
  }
  if (preview.kind === 'text') {
    return <pre className="response-preview-text mono"><MarkedText text={preview.text} query={query} activeIndex={activeIndex} /></pre>;
  }
  if (preview.kind === 'csv') {
    const rows = preview.rows.map((cells, index) => ({ number: String(index + 1), cells: cells.map((value, column) => ({ ref: `${columnName(column)}${index + 1}`, value })) }));
    return <Grid rows={rows} query={query} activeIndex={activeIndex} />;
  }
  if (preview.kind === 'spreadsheet') {
    const sheet = preview.sheets[Math.min(selected, preview.sheets.length - 1)];
    return <div className="response-preview-workbook">
      <div className="response-preview-tabs" role="tablist" aria-label={t('detail.preview.sheets')}>
        {preview.sheets.map((item, index) => <button key={`${item.name}-${index}`} type="button" role="tab" aria-selected={selected === index} className={selected === index ? 'active' : ''} onClick={() => setSelected(index)}>{item.name}</button>)}
      </div>
      {sheet ? <Grid rows={sheet.rows} query={query} activeIndex={activeIndex} /> : <p className="muted">{t('common.empty')}</p>}
      <p className="response-preview-note muted">{t('detail.preview.sheetLimit')}</p>
    </div>;
  }
  if (preview.kind === 'archive') {
    const item = preview.entries[Math.min(selected, preview.entries.length - 1)];
    const entryOffsets = preview.entries.map((_, index) => preview.entries.slice(0, index).reduce(
      (sum, entry) => sum + matchCount(entry.name, query), 0,
    ));
    const itemTextOffset = preview.entries.reduce((sum, entry) => sum + matchCount(entry.name, query), 0);
    return <div className="response-preview-archive">
      <p className="response-preview-note muted">{t('detail.preview.archiveCount', { count: String(preview.total_entries) })}</p>
      <div className="response-preview-archive-content">
        <div className="response-preview-files" role="listbox" aria-label={t('detail.preview.archiveFiles')}>
          {preview.entries.map((entry, index) => {
            return <button key={`${entry.name}-${index}`} type="button" role="option" aria-selected={selected === index} className={selected === index ? 'active' : ''} onClick={() => setSelected(index)}><span title={entry.name}>{entry.directory ? '📁 ' : '📄 '}<MarkedText text={entry.name} query={query} activeIndex={activeIndex} offset={entryOffsets[index]} /></span><small>{entry.directory ? '' : `${entry.size.toLocaleString()} B`}</small></button>;
          })}
        </div>
        <div className="response-preview-file-detail">
          {item && <><strong>{item.name}</strong><p className="muted">{t('detail.preview.fileSize', { size: item.size.toLocaleString() })}</p><pre className="mono"><MarkedText text={item.text ?? t('detail.preview.binaryFile')} query={item.text === null ? '' : query} activeIndex={activeIndex} offset={itemTextOffset} /></pre></>}
        </div>
      </div>
    </div>;
  }
  return null;
}

export function ResponsePreview({ flowId, query = '', activeIndex = null, onMatchCount = NOOP_MATCH_COUNT }: {
  flowId: string;
  query?: string;
  activeIndex?: number | null;
  onMatchCount?: (count: number) => void;
}) {
  const t = useT();
  const [result, setResult] = useState<{ flowId: string; preview?: PreviewData; error?: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    onMatchCount(0);
    getResponsePreview(flowId)
      .then((data) => { if (!cancelled) setResult({ flowId, preview: data }); })
      .catch((cause: unknown) => { if (!cancelled) setResult({ flowId, error: cause instanceof Error ? cause.message : String(cause) }); });
    return () => { cancelled = true; };
  }, [flowId, onMatchCount]);

  if (result?.flowId !== flowId) return <p className="muted">{t('detail.preview.loading')}</p>;
  if (result.error) return <p className="banner error">{t('detail.preview.failed', { message: result.error })}</p>;
  if (!result.preview) return <p className="muted">{t('detail.preview.loading')}</p>;
  return <div className="response-preview"><PreviewContent preview={result.preview} query={query} activeIndex={activeIndex} onMatchCount={onMatchCount} /></div>;
}

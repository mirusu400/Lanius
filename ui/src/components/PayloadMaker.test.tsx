import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PayloadPicker } from './PayloadPicker';
import { PayloadMaker } from './PayloadMaker';
import { generatePayloads, type PayloadMakerConfig } from './payloadMakerModel';
import { ParseError } from '../i18n/ParseError';
import { renderWithI18n as render, t } from '../test-utils';

/** Use the real generator while controlling worker delivery/cancellation. */
class ModelWorker {
  static instances: ModelWorker[] = [];
  static hold = false;
  onmessage: ((event: { data: { text?: string; error?: string } }) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  stopped = false;
  constructor() { ModelWorker.instances.push(this); }
  terminate() { this.stopped = true; }
  postMessage(data: { config: PayloadMakerConfig; appendTo?: string }) {
    if (ModelWorker.hold) return;
    queueMicrotask(() => {
      if (this.stopped) return;
      try { this.onmessage?.({ data: { text: generatePayloads(data.config, data.appendTo) } }); }
      catch (error) { this.onmessage?.({ data: { error: error instanceof ParseError ? error.key : 'payloadMaker.failed' } }); }
    });
  }
}

beforeEach(() => {
  window.localStorage.clear();
  ModelWorker.instances = [];
  ModelWorker.hold = false;
  vi.stubGlobal('Worker', ModelWorker);
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const change = (key: Parameters<typeof t>[0], value: string) => {
  if (key === 'payloadMaker.source') {
    fireEvent.change(screen.getByRole('combobox', { name: t(key) }), { target: { value } });
    return;
  }
  fireEvent.change(screen.getByLabelText(t(key)), { target: { value } });
};
const selectStep = (index: number, value: string) => fireEvent.change(screen.getByLabelText(t('payloadMaker.operation', { index })), { target: { value } });
const addStep = () => fireEvent.click(screen.getByRole('button', { name: t('payloadMaker.addStep') }));

describe('Payload Maker dialog', () => {
  it('opens for a set, previews a padded range, and only changes it on apply', async () => {
    const onChange = vi.fn();
    render(<PayloadPicker index={0} value="old" onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: t('payloadMaker.title') }));
    expect(screen.getByRole('dialog', { name: t('payloadMaker.title') })).toBeTruthy();
    change('payloadMaker.end', '4');
    change('payloadMaker.step', '2');
    change('payloadMaker.padding', '4');
    expect(within(screen.getByRole('region', { name: t('payloadMaker.preview') })).getAllByText('0002')).toHaveLength(2);
    expect(onChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: t('payloadMaker.replaceSet') }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('0000\n0002\n0004'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('generates character combinations and appends to the chosen set', async () => {
    const onFirst = vi.fn();
    const onSecond = vi.fn();
    render(<><PayloadPicker index={0} value="first" onChange={onFirst} />
      <PayloadPicker index={1} value="second" onChange={onSecond} /></>);
    fireEvent.click(screen.getAllByRole('button', { name: t('payloadMaker.title') })[1]);
    change('payloadMaker.source', 'characters');
    change('payloadMaker.alphabet', 'ab');
    fireEvent.click(screen.getByRole('button', { name: t('payloadMaker.appendSet') }));
    await waitFor(() => expect(onSecond).toHaveBeenCalledWith('second\na\nb\naa\nab\nba\nbb'));
    expect(onFirst).not.toHaveBeenCalled();
  });

  it('reorders and removes processing steps', async () => {
    const onUse = vi.fn();
    render(<PayloadMaker open value="" onUse={onUse} onClose={vi.fn()} />);
    change('payloadMaker.end', '0');
    addStep();
    fireEvent.change(screen.getByLabelText(t('payloadMaker.text', { index: 1 })), { target: { value: 'id-' } });
    addStep();
    selectStep(2, 'base64');
    expect(screen.getByText('aWQtMA==')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('payloadMaker.moveUp', { index: 2 }) }));
    expect(screen.getByText('id-MA==')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('payloadMaker.removeStep', { index: 2 }) }));
    fireEvent.click(screen.getByRole('button', { name: t('payloadMaker.replaceSet') }));
    await waitFor(() => expect(onUse).toHaveBeenCalledWith('MA=='));
  });

  it('post-processes the current set with visible duplicate removal', async () => {
    const onUse = vi.fn();
    render(<PayloadMaker open value={'a\nA\nb'} onUse={onUse} onClose={vi.fn()} />);
    change('payloadMaker.source', 'existing');
    addStep(); selectStep(1, 'uppercase');
    addStep(); selectStep(2, 'deduplicate');
    expect(screen.getByText(t('payloadMaker.removed'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('payloadMaker.replaceSet') }));
    await waitFor(() => expect(onUse).toHaveBeenCalledWith('A\nB'));
  });

  it('offers four source types in a dropdown and generates formatted dates', async () => {
    const onUse = vi.fn();
    render(<PayloadMaker open value="old" onUse={onUse} onClose={vi.fn()} />);
    const source = screen.getByRole('combobox', { name: t('payloadMaker.source') });
    expect(within(source).getAllByRole('option')).toHaveLength(4);
    change('payloadMaker.source', 'dates');
    change('payloadMaker.dateStart', '2024-02-28');
    change('payloadMaker.dateEnd', '2024-03-01');
    change('payloadMaker.dateFormat', 'YYYYMMDD');
    expect(screen.getAllByText('20240229')).toHaveLength(2);
    addStep(); selectStep(1, 'base64');
    fireEvent.click(screen.getByRole('button', { name: t('payloadMaker.appendSet') }));
    await waitFor(() => expect(onUse).toHaveBeenCalledWith('old\nMjAyNDAyMjg=\nMjAyNDAyMjk=\nMjAyNDAzMDE='));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps date settings when switching sources and blocks invalid intervals', () => {
    render(<PayloadMaker open value="" onUse={vi.fn()} onClose={vi.fn()} />);
    change('payloadMaker.source', 'dates');
    change('payloadMaker.dateStart', '2026-10-20');
    change('payloadMaker.dateEnd', '2026-10-22');
    change('payloadMaker.dateStep', '2');
    change('payloadMaker.source', 'numbers');
    change('payloadMaker.source', 'dates');
    expect((screen.getByLabelText(t('payloadMaker.dateStart')) as HTMLInputElement).value).toBe('2026-10-20');
    expect(screen.getByText(t('payloadMaker.sample', { count: 2 }))).toBeTruthy();
    change('payloadMaker.dateStep', '0');
    expect(screen.getByRole('alert').textContent).toBe(t('payloadMaker.invalidStep'));
    expect((screen.getByRole('button', { name: t('payloadMaker.replaceSet') }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows request estimates for replace and append', () => {
    render(<PayloadMaker open value={'a\nb'} onUse={vi.fn()} onClose={vi.fn()} requestCount={(count) => count * 2} />);
    change('payloadMaker.end', '2');
    fireEvent.click(screen.getByText(t('payloadMaker.requestEstimates')));
    expect(screen.getByText(t('payloadMaker.requests', { count: '6' }))).toBeTruthy();
    expect(screen.getByText(t('payloadMaker.appendRequests', { count: '10' }))).toBeTruthy();
  });

  it('rejects invalid settings and huge lists before starting a worker', () => {
    render(<PayloadMaker open value="" onUse={vi.fn()} onClose={vi.fn()} />);
    change('payloadMaker.step', '0');
    expect(screen.getByRole('alert').textContent).toBe(t('payloadMaker.invalidStep'));
    expect((screen.getByRole('button', { name: t('payloadMaker.replaceSet') }) as HTMLButtonElement).disabled).toBe(true);
    change('payloadMaker.source', 'characters');
    change('payloadMaker.maxLength', '32');
    expect(screen.getByRole('alert').textContent).toBe(t('payloadMaker.limitCount'));
    expect((screen.getByRole('button', { name: t('payloadMaker.appendSet') }) as HTMLButtonElement).disabled).toBe(true);
    expect(ModelWorker.instances).toHaveLength(0);
  });

  it('validates values beyond the preview and keeps the set intact on failure', async () => {
    const onUse = vi.fn();
    render(<PayloadMaker open value="old" onUse={onUse} onClose={vi.fn()} />);
    change('payloadMaker.end', '100');
    addStep(); selectStep(1, 'replace');
    fireEvent.change(screen.getByLabelText(t('payloadMaker.search', { index: 1 })), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: t('payloadMaker.replaceSet') }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(t('payloadMaker.invalidOutput')));
    expect(onUse).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('cancels an in-flight generation without changing the set', async () => {
    ModelWorker.hold = true;
    const onChange = vi.fn();
    render(<PayloadPicker index={0} value="old" onChange={onChange} />);
    const user = userEvent.setup();
    const opener = screen.getByRole('button', { name: t('payloadMaker.title') });
    await user.click(opener);
    await user.click(screen.getByRole('button', { name: t('payloadMaker.replaceSet') }));
    expect(screen.getByRole('status').textContent).toBe(t('payloadMaker.generating'));
    await user.click(screen.getByRole('button', { name: t('common.cancel') }));
    expect(ModelWorker.instances[0].stopped).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('terminates the worker when its set is unmounted', () => {
    ModelWorker.hold = true;
    const view = render(<PayloadMaker open value="" onUse={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: t('payloadMaker.replaceSet') }));
    view.unmount();
    expect(ModelWorker.instances[0].stopped).toBe(true);
  });
});

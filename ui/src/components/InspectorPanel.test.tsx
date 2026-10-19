/** The Inspector against a mocked engine, alone and inside Replay. */
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InspectorPanel } from './InspectorPanel';
import { rememberedCharset } from './inspectorModel';
import { renderWithI18n as render, t } from '../test-utils';
import { ReplayTabView } from '../tabs/ReplayTab';
import { getTabs, resetTabs, setTabs } from '../tabs/replayStore';

const decoded = {
  layers: [{ kind: 'url' }, { kind: 'charset', charset: 'cp949', label: 'EUC-KR / CP949' }],
  text: '홍길동',
  hex: null,
  editable: true,
  charset: {
    name: 'cp949',
    label: 'EUC-KR / CP949',
    confidence: 'medium',
    reasons: [{ code: 'tld', detail: '.kr' }],
    candidates: [
      { name: 'cp949', label: 'EUC-KR / CP949', text: '홍길동', score: 1.2 },
      { name: 'gb18030', label: 'GB18030 / GBK', text: '盒菩떠', score: 0.7 },
    ],
  },
};

let calls: { path: string; body: Record<string, unknown> }[] = [];
let applyResponse: { status: number; body: unknown } = { status: 200, body: { value: '%B1%E8' } };

beforeEach(() => {
  calls = [];
  applyResponse = { status: 200, body: { value: '%B1%E8' } };
  resetTabs();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ path, body });
      const reply = path.includes('/api/inspect/apply')
        ? applyResponse
        : path.includes('/api/inspect')
          ? { status: 200, body: decoded }
          : { status: 200, body: {} };
      return {
        ok: reply.status < 400,
        status: reply.status,
        statusText: '',
        json: async () => reply.body,
        clone() { return this; },
      } as unknown as Response;
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

const request = 'GET /s?q=%C8%AB%B1%E6%B5%BF HTTP/1.1\nHost: shop.example.kr\n\n';
const inspectCalls = () => calls.filter((c) => c.path.endsWith('/api/inspect'));

describe('InspectorPanel', () => {
  it('asks for a selection when there is none', () => {
    render(<InspectorPanel selection={null} request="" />);
    expect(screen.getByText(t('inspector.empty'))).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it('shows the decoded text, its layers and why the charset was chosen', async () => {
    render(<InspectorPanel selection={{ text: '%C8%AB%B1%E6%B5%BF' }} request={request} />);

    const output = await screen.findByLabelText(t('inspector.decoded')) as HTMLTextAreaElement;
    expect(output.value).toBe('홍길동');
    expect(screen.getByText('URL')).toBeTruthy();
    expect(screen.getAllByText('EUC-KR / CP949').length).toBeGreaterThan(0);
    expect(screen.getByText(t('inspector.reason.tld', { detail: '.kr' }))).toBeTruthy();
    expect(inspectCalls()[0].body).toMatchObject({
      value: '%C8%AB%B1%E6%B5%BF',
      request,
      form: true,
      charset: null,
    });
  });

  it('re-reads with a chosen charset and remembers it for the host', async () => {
    render(<InspectorPanel selection={{ text: '%C8%AB' }} request={request} />);
    await screen.findByLabelText(t('inspector.decoded'));

    fireEvent.change(screen.getByLabelText(t('inspector.charset')), { target: { value: 'gb18030' } });

    await waitFor(() => expect(inspectCalls().at(-1)?.body.charset).toBe('gb18030'));
    expect(rememberedCharset('shop.example.kr')).toBe('gb18030');
  });

  it('is read-only in History and offers Replay instead', async () => {
    const edit = vi.fn();
    render(<InspectorPanel selection={{ text: '%C8%AB' }} request={request} onEditInReplay={edit} />);

    const output = await screen.findByLabelText(t('inspector.decoded')) as HTMLTextAreaElement;
    expect(output.readOnly).toBe(true);
    expect(screen.queryByRole('button', { name: t('inspector.apply') })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: t('inspector.editInReplay') }));
    expect(edit).toHaveBeenCalled();
  });

  it('encodes an edit back and hands it to the editor', async () => {
    const onApply = vi.fn(() => true);
    const selection = { text: '%C8%AB%B1%E6%B5%BF', start: 8, end: 26 };
    render(<InspectorPanel selection={selection} request={request} onApply={onApply} />);
    const output = await screen.findByLabelText(t('inspector.decoded'));

    fireEvent.change(output, { target: { value: '김' } });
    await userEvent.click(screen.getByRole('button', { name: t('inspector.apply') }));

    await waitFor(() => expect(onApply).toHaveBeenCalledWith(selection, '%B1%E8'));
    const applied = calls.find((c) => c.path.endsWith('/api/inspect/apply'));
    expect(applied?.body).toMatchObject({ value: selection.text, text: '김', charset: 'cp949' });
  });

  it('explains a character the charset cannot hold', async () => {
    applyResponse = { status: 400, body: { detail: 'CHARSET_UNENCODABLE:EUC-KR / CP949:😀' } };
    render(<InspectorPanel selection={{ text: '%C8%AB', start: 0, end: 6 }} request={request} onApply={() => true} />);
    const output = await screen.findByLabelText(t('inspector.decoded'));

    fireEvent.change(output, { target: { value: '😀' } });
    await userEvent.click(screen.getByRole('button', { name: t('inspector.apply') }));

    expect(await screen.findByText(t('inspector.unencodable', { charset: 'EUC-KR / CP949', char: '😀' }))).toBeTruthy();
  });

  it('says so when the request changed under the selection', async () => {
    render(<InspectorPanel selection={{ text: '%C8%AB', start: 0, end: 6 }} request={request} onApply={() => false} />);
    const output = await screen.findByLabelText(t('inspector.decoded'));

    fireEvent.change(output, { target: { value: '김' } });
    await userEvent.click(screen.getByRole('button', { name: t('inspector.apply') }));

    expect(await screen.findByText(t('inspector.stale'))).toBeTruthy();
  });
});

describe('Inspector in Replay', () => {
  it('follows the editor selection and replaces it on apply', async () => {
    setTabs([{
      id: 'tab', title: 'tab', url: 'http://shop.example.kr',
      text: request, response: null, sending: false, error: null,
    }]);
    render(<ReplayTabView />);
    await userEvent.click(screen.getByRole('tab', { name: t('detail.view.raw') }));
    const editor = screen.getByRole('textbox', { name: t('replay.request') }) as HTMLTextAreaElement;
    const start = request.indexOf('%C8');
    const end = request.indexOf(' HTTP');

    act(() => {
      editor.focus();
      editor.setSelectionRange(start, end);
      document.dispatchEvent(new Event('selectionchange'));
    });
    const output = await screen.findByLabelText(t('inspector.decoded'));
    expect(inspectCalls()[0].body.value).toBe('%C8%AB%B1%E6%B5%BF');

    fireEvent.change(output, { target: { value: '김' } });
    await userEvent.click(screen.getByRole('button', { name: t('inspector.apply') }));

    await waitFor(() => expect(getTabs()[0].text).toBe('GET /s?q=%B1%E8 HTTP/1.1\nHost: shop.example.kr\n\n'));
  });

  it('can be hidden, and stays hidden', async () => {
    setTabs([{
      id: 'tab', title: 'tab', url: 'http://shop.example.kr',
      text: request, response: null, sending: false, error: null,
    }]);
    const view = render(<ReplayTabView />);
    expect(screen.getByLabelText(t('inspector.title'))).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: t('inspector.toggleLabel') }));
    expect(screen.queryByLabelText(t('inspector.title'))).toBeNull();

    view.unmount();
    render(<ReplayTabView />);
    expect(screen.queryByLabelText(t('inspector.title'))).toBeNull();
  });
});

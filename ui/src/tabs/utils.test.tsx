/** Decoder + Comparer tabs rendered against a mocked engine. */
import {cleanup, screen, waitFor } from '@testing-library/react';
import { renderWithI18n as render, t } from '../test-utils';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DecoderTab } from './DecoderTab';
import { ComparerTab } from './ComparerTab';

let decodeCalls: { value: string; steps: { codec: string; direction: string }[] }[] =
  [];
let failNext = false;

function jsonResponse(body: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 400,
    statusText: ok ? 'OK' : 'Bad Request',
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  decodeCalls = [];
  failNext = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;

      if (url.endsWith('/api/codecs')) {
        return jsonResponse({
          codecs: ['base64', 'hex', 'url'],
          hashes: ['sha256'],
        });
      }
      if (url.endsWith('/api/decode')) {
        decodeCalls.push(body);
        if (failNext) return jsonResponse({ detail: 'invalid base64' }, false);
        // Simulate the engine: each step uppercases, so output is observable.
        let current = body.value;
        const steps = body.steps.map(
          (s: { codec: string; direction: string }) => {
            current = `${s.codec}:${s.direction}(${current})`;
            return { ...s, value: current };
          },
        );
        return jsonResponse({ input: body.value, steps, output: current });
      }
      if (url.endsWith('/api/compare')) {
        return jsonResponse({
          mode: body.mode,
          blocks: [
            { tag: 'equal', left: 'the', right: 'the' },
            { tag: 'replace', left: 'quick', right: 'slow' },
            { tag: 'insert', left: '', right: 'extra' },
          ],
          added: 2,
          removed: 1,
          unchanged: 1,
          similarity: 0.5,
          identical: false,
        });
      }
      return jsonResponse({});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DecoderTab', () => {
  it('starts with no chain steps', async () => {
    render(<DecoderTab />);
    expect(await screen.findByText(t('decoder.chainSteps', { count: 0 }))).toBeTruthy();
  });

  it('adds a step and shows its output', async () => {
    const user = userEvent.setup();
    render(<DecoderTab />);
    await user.type(screen.getByLabelText(t('decoder.inputLabel')), 'aGk=');
    await user.click(screen.getByRole('button', { name: t('decoder.addStep') }));

    await waitFor(() =>
      expect(screen.getByText(/base64:decode\(aGk=\)/)).toBeTruthy(),
    );
    expect(decodeCalls.at(-1)?.steps).toEqual([
      { codec: 'base64', direction: 'decode' },
    ]);
  });

  it('chains multiple steps in order', async () => {
    const user = userEvent.setup();
    render(<DecoderTab />);
    await user.type(screen.getByLabelText(t('decoder.inputLabel')), 'x');
    await user.click(screen.getByRole('button', { name: t('decoder.addStep') }));
    await user.click(screen.getByRole('button', { name: t('decoder.addStep') }));
    await user.selectOptions(screen.getByLabelText(t('decoder.codec', { index: 2 })), 'url');

    await waitFor(() =>
      expect(
        screen.getByText(/url:decode\(base64:decode\(x\)\)/),
      ).toBeTruthy(),
    );
  });

  it('switches a step to encode', async () => {
    const user = userEvent.setup();
    render(<DecoderTab />);
    await user.type(screen.getByLabelText(t('decoder.inputLabel')), 'x');
    await user.click(screen.getByRole('button', { name: t('decoder.addStep') }));
    await user.selectOptions(screen.getByLabelText(t('decoder.direction', { index: 1 })), 'encode');
    await waitFor(() =>
      expect(screen.getByText(/base64:encode\(x\)/)).toBeTruthy(),
    );
  });

  it('removes a step', async () => {
    const user = userEvent.setup();
    render(<DecoderTab />);
    await user.click(screen.getByRole('button', { name: t('decoder.addStep') }));
    await screen.findByText(t('decoder.chainSteps', { count: 1 }));
    await user.click(screen.getByLabelText(t('decoder.removeStep', { index: 1 })));
    expect(await screen.findByText(t('decoder.chainSteps', { count: 0 }))).toBeTruthy();
  });

  it('surfaces engine errors', async () => {
    const user = userEvent.setup();
    render(<DecoderTab />);
    failNext = true;
    await user.click(screen.getByRole('button', { name: t('decoder.addStep') }));
    expect(await screen.findByText(/400/)).toBeTruthy();
  });
});

describe('ComparerTab', () => {
  it('renders a diff with change counts', async () => {
    const user = userEvent.setup();
    render(<ComparerTab />);
    await user.type(screen.getByLabelText(t('comparer.left')), 'the quick');
    await user.type(screen.getByLabelText(t('comparer.right')), 'the slow extra');
    await user.click(screen.getByRole('button', { name: t('comparer.compare') }));

    const diff = await screen.findByTestId('diff');
    expect(diff.textContent).toContain('quick\u2192slow');
    expect(diff.textContent).toContain('extra');
    expect(screen.getByText(t('comparer.summary', { added: 2, removed: 1, percent: '50.0' }))).toBeTruthy();
  });

  it('marks insertions and replacements with classes', async () => {
    const user = userEvent.setup();
    render(<ComparerTab />);
    await user.click(screen.getByRole('button', { name: t('comparer.compare') }));
    await screen.findByTestId('diff');
    expect(document.querySelectorAll('.diff-replace')).toHaveLength(1);
    expect(document.querySelectorAll('.diff-insert')).toHaveLength(1);
  });

  it('supports byte mode', async () => {
    const user = userEvent.setup();
    render(<ComparerTab />);
    await user.selectOptions(screen.getByLabelText(t('comparer.mode')), 'byte');
    await user.click(screen.getByRole('button', { name: t('comparer.compare') }));
    await screen.findByTestId('diff');
    const call = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } })
      .mock.calls.at(-1);
    expect(call, 'compareTexts should have been called').toBeTruthy();
    const init = call![1] as RequestInit;
    expect(JSON.parse(String(init.body)).mode).toBe('byte');
  });
});

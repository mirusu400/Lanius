import { cleanup, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderWithI18n } from '../test-utils';
import { UndoableInput, UndoableTextarea } from './UndoableText';

afterEach(cleanup);

function InputHarness({ type = 'text' }: { type?: 'text' | 'number' }) {
  const [value, setValue] = useState('12');
  return <UndoableInput aria-label="input" type={type} value={value} onValueChange={setValue} />;
}

function KeyedTextareaHarness() {
  const [active, setActive] = useState<'a' | 'b'>('a');
  const [values, setValues] = useState({ a: 'alpha', b: 'bravo' });
  return <>
    <button onClick={() => setActive('a')}>A</button>
    <button onClick={() => setActive('b')}>B</button>
    <UndoableTextarea
      aria-label="editor"
      historyKey={active}
      value={values[active]}
      onValueChange={(value) => setValues((current) => ({ ...current, [active]: value }))}
    />
  </>;
}

describe('UndoableText', () => {
  it('undoes and redoes a controlled single-line input', async () => {
    const user = userEvent.setup();
    renderWithI18n(<InputHarness />);
    const input = screen.getByRole('textbox', { name: 'input' }) as HTMLInputElement;
    input.setSelectionRange(input.value.length, input.value.length);
    await user.type(input, '3');
    expect(input.value).toBe('123');

    fireEvent.keyDown(input, { key: 'z', code: 'KeyZ', ctrlKey: true });
    expect(input.value).toBe('12');
    fireEvent.keyDown(input, { key: 'z', code: 'KeyZ', ctrlKey: true, shiftKey: true });
    expect(input.value).toBe('123');
  });

  it('supports number inputs whose DOM does not expose a selection', async () => {
    const user = userEvent.setup();
    renderWithI18n(<InputHarness type="number" />);
    const input = screen.getByRole('spinbutton', { name: 'input' }) as HTMLInputElement;
    await user.type(input, '3');
    expect(input.value).toBe('123');
    fireEvent.keyDown(input, { key: 'z', code: 'KeyZ', metaKey: true });
    expect(input.value).toBe('12');
  });

  it('keeps independent histories when one editor switches documents', async () => {
    const user = userEvent.setup();
    renderWithI18n(<KeyedTextareaHarness />);
    const editor = () => screen.getByRole('textbox', { name: 'editor' }) as HTMLTextAreaElement;

    editor().setSelectionRange(5, 5);
    await user.type(editor(), '-a');
    await user.click(screen.getByRole('button', { name: 'B' }));
    editor().setSelectionRange(5, 5);
    await user.type(editor(), '-b');

    await user.click(screen.getByRole('button', { name: 'A' }));
    expect(editor().value).toBe('alpha-a');
    fireEvent.keyDown(editor(), { key: 'z', code: 'KeyZ', ctrlKey: true });
    expect(editor().value).toBe('alpha');

    await user.click(screen.getByRole('button', { name: 'B' }));
    expect(editor().value).toBe('bravo-b');
    fireEvent.keyDown(editor(), { key: 'z', code: 'KeyZ', ctrlKey: true });
    expect(editor().value).toBe('bravo');
  });
});

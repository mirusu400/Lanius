/** The size field: typed values and a list of the usual ones. */
import { cleanup, fireEvent, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SizeField } from './SizeField';

afterEach(cleanup);

function renderField(props: Partial<React.ComponentProps<typeof SizeField>> = {}) {
  const onChange = vi.fn();
  render(
    <SizeField
      id="size"
      value={13}
      min={10}
      max={20}
      presets={[10, 12, 13, 16, 20]}
      onChange={onChange}
      {...props}
    />,
  );
  return { onChange };
}

const field = () => document.getElementById('size') as HTMLInputElement;

describe('SizeField', () => {
  it('takes a typed size, which a slider makes hard to land on', async () => {
    const { onChange } = renderField();
    await userEvent.clear(field());
    await userEvent.type(field(), '17');
    expect(onChange).toHaveBeenLastCalledWith(17);
  });

  it('does not fight a number being typed', async () => {
    // Clamping on every keystroke would turn the "1" of "16" into the
    // minimum and swallow the next digit.
    const { onChange } = renderField();
    await userEvent.clear(field());
    await userEvent.type(field(), '1');
    expect(field().value).toBe('1');
    await userEvent.type(field(), '6');
    expect(field().value).toBe('16');
    expect(onChange).toHaveBeenLastCalledWith(16);
  });

  it('clamps an out-of-range size when you leave the field', async () => {
    const { onChange } = renderField();
    await userEvent.clear(field());
    await userEvent.type(field(), '99');
    fireEvent.blur(field());
    expect(field().value).toBe('20');
    expect(onChange).toHaveBeenLastCalledWith(20);
  });

  it('restores the current size when the field is left empty', async () => {
    renderField();
    await userEvent.clear(field());
    fireEvent.blur(field());
    expect(field().value).toBe('13');
  });

  it('offers the usual sizes from the field itself', () => {
    // One control, not a box beside a dropdown: a datalist is a field
    // that also suggests. Verified in WKWebView that the desktop build
    // draws the picker for it.
    renderField();
    const list = document.getElementById('size-presets') as HTMLDataListElement;
    expect(list).toBeTruthy();
    expect([...list.options].map((o) => o.value)).toEqual([
      '10',
      '12',
      '13',
      '16',
      '20',
    ]);
  });

  it('points the field at its list', () => {
    renderField();
    expect(field().getAttribute('list')).toBe('size-presets');
  });

  it('is one control, not two', () => {
    // The pair of controls read as a mistake, which is what they were.
    renderField();
    expect(document.querySelectorAll('.size-field select')).toHaveLength(0);
    expect(document.querySelectorAll('.size-field input')).toHaveLength(1);
  });

  it('accepts a size that is not one of the presets', () => {
    renderField({ value: 17 });
    expect(field().value).toBe('17');
  });

  it('follows the value it is given', () => {
    renderField({ value: 11 });
    expect(field().value).toBe('11');
  });
});

/** The loading indicator, and the rules about when it appears. */
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MIN_VISIBLE_MS,
  SHOW_AFTER_MS,
  Spinner,
  useDelayedBusy,
} from './Spinner';
import { BusyProvider, useReportBusy } from './busy';
import { renderWithI18n } from '../test-utils';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

describe('useDelayedBusy', () => {
  it('stays hidden for a load that finishes quickly', () => {
    // The point of the whole thing: a spinner that appears and vanishes
    // within a few frames reads as a glitch, not as feedback.
    const { result, rerender } = renderHook(({ busy }) => useDelayedBusy(busy), {
      initialProps: { busy: true },
    });
    advance(SHOW_AFTER_MS - 50);
    rerender({ busy: false });
    advance(1000);
    expect(result.current).toBe(false);
  });

  it('appears once the wait is long enough to notice', () => {
    const { result } = renderHook(() => useDelayedBusy(true));
    expect(result.current).toBe(false);
    advance(SHOW_AFTER_MS + 10);
    expect(result.current).toBe(true);
  });

  it('stays up briefly once shown', () => {
    // Otherwise a load that finishes just after the spinner appears
    // produces the same flicker, in reverse.
    const { result, rerender } = renderHook(({ busy }) => useDelayedBusy(busy), {
      initialProps: { busy: true },
    });
    advance(SHOW_AFTER_MS + 10);
    expect(result.current).toBe(true);
    rerender({ busy: false });
    advance(MIN_VISIBLE_MS / 2);
    expect(result.current).toBe(true);
    advance(MIN_VISIBLE_MS);
    expect(result.current).toBe(false);
  });

  it('hides eventually after a long load', () => {
    const { result, rerender } = renderHook(({ busy }) => useDelayedBusy(busy), {
      initialProps: { busy: true },
    });
    advance(5000);
    rerender({ busy: false });
    advance(MIN_VISIBLE_MS + 50);
    expect(result.current).toBe(false);
  });

  it('shows again for a second slow load', () => {
    const { result, rerender } = renderHook(({ busy }) => useDelayedBusy(busy), {
      initialProps: { busy: true },
    });
    advance(SHOW_AFTER_MS + 10);
    rerender({ busy: false });
    advance(MIN_VISIBLE_MS + 50);
    expect(result.current).toBe(false);
    rerender({ busy: true });
    advance(SHOW_AFTER_MS + 10);
    expect(result.current).toBe(true);
  });
});

describe('Spinner', () => {
  it('announces itself to a screen reader', () => {
    renderWithI18n(<Spinner />);
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('uses the label it is given', () => {
    renderWithI18n(<Spinner label="Fetching" />);
    expect(screen.getByLabelText('Fetching')).toBeTruthy();
  });
});

describe('BusyProvider', () => {
  function Tab({ id, busy }: { id: string; busy: boolean }) {
    useReportBusy(id, busy);
    return null;
  }

  it('is busy while any tab is loading', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <BusyProvider onChange={onChange}>
        <Tab id="a" busy={true} />
        <Tab id="b" busy={true} />
      </BusyProvider>,
    );
    expect(onChange).toHaveBeenLastCalledWith(true);

    // One finishing is not enough; the other is still going.
    rerender(
      <BusyProvider onChange={onChange}>
        <Tab id="a" busy={false} />
        <Tab id="b" busy={true} />
      </BusyProvider>,
    );
    expect(onChange).toHaveBeenLastCalledWith(true);

    rerender(
      <BusyProvider onChange={onChange}>
        <Tab id="a" busy={false} />
        <Tab id="b" busy={false} />
      </BusyProvider>,
    );
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('clears when a tab is switched away from mid-load', () => {
    // Otherwise the indicator spins forever on a tab that is gone.
    const onChange = vi.fn();
    const { rerender } = render(
      <BusyProvider onChange={onChange}>
        <Tab id="a" busy={true} />
      </BusyProvider>,
    );
    expect(onChange).toHaveBeenLastCalledWith(true);
    rerender(<BusyProvider onChange={onChange}>{null}</BusyProvider>);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('starts idle', () => {
    const onChange = vi.fn();
    render(<BusyProvider onChange={onChange}>{null}</BusyProvider>);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });
});

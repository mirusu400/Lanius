import { cleanup, renderHook } from '@testing-library/react';
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';

import { notifyRequestTransferred } from '../requestTransfers';
import { useRequestTransferIndicators } from './useRequestTransferIndicators';

afterEach(cleanup);

it('marks transfers to hidden workspaces and clears them when opened', () => {
  const { result, rerender } = renderHook(
    ({ active }) => useRequestTransferIndicators(active),
    { initialProps: { active: 'Proxy' } },
  );

  act(() => notifyRequestTransferred('Replay'));
  expect(result.current.indicators.has('Replay')).toBe(true);
  expect(result.current.indicators.has('Fuzzer')).toBe(false);

  act(() => result.current.clearIndicator('Replay'));
  rerender({ active: 'Replay' });
  expect(result.current.indicators.has('Replay')).toBe(false);

  act(() => notifyRequestTransferred('Replay'));
  expect(result.current.indicators.has('Replay')).toBe(false);
});

it('tracks Replay and Fuzzer independently', () => {
  const { result } = renderHook(() => useRequestTransferIndicators('Proxy'));
  act(() => {
    notifyRequestTransferred('Replay');
    notifyRequestTransferred('Fuzzer');
  });
  expect([...result.current.indicators]).toEqual(['Replay', 'Fuzzer']);

  act(() => result.current.clearIndicator('Fuzzer'));
  expect([...result.current.indicators]).toEqual(['Replay']);
});

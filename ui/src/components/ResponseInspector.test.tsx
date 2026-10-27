import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';

import { renderWithI18n as render, t } from '../test-utils';
import { ResponseInspector } from './ResponseInspector';

afterEach(cleanup);

const RAW = 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"a":1,"b":2}';

it('opens responses in Pretty and offers Pretty, Raw, Hex and Preview in order', async () => {
  render(<ResponseInspector flowId="response-1" raw={RAW} empty="no response" />);

  const tabs = screen.getAllByRole('tab');
  expect(tabs.map((node) => node.textContent)).toEqual([
    t('detail.view.parsed'),
    t('detail.view.raw'),
    t('detail.view.hex'),
    t('detail.view.preview'),
  ]);
  expect(tabs[0].getAttribute('aria-selected')).toBe('true');
  expect(document.querySelector('.replay-response')?.textContent).toContain('"a": 1');

  await userEvent.click(tabs[1]);
  expect(document.querySelector('.replay-response')?.textContent).toBe(RAW);

  await userEvent.click(tabs[2]);
  expect(document.querySelector('.replay-response')?.textContent).toContain('48 54 54 50');
});

it('preserves display choices across views while keeping the raw response intact', async () => {
  render(<ResponseInspector flowId="response-1" raw={RAW} empty="no response" />);
  const endings = screen.getByRole('button', { name: t('body.showLineEndings') });
  const wrap = screen.getByRole('button', { name: t('body.wrap') });
  await userEvent.click(endings);
  await userEvent.click(wrap);
  await userEvent.click(screen.getByRole('tab', { name: t('detail.view.raw') }));
  expect(document.querySelector('.replay-response')?.textContent).toBe(RAW);
  expect(document.querySelectorAll('.code-line-ending')).toHaveLength(3);
  await userEvent.click(screen.getByRole('tab', { name: t('detail.view.hex') }));
  expect(endings).toHaveProperty('disabled', true);
  expect(wrap).toHaveProperty('disabled', true);
  await userEvent.click(screen.getByRole('tab', { name: t('detail.view.parsed') }));
  expect(endings.getAttribute('aria-pressed')).toBe('true');
  expect(wrap.getAttribute('aria-pressed')).toBe('false');
  expect(document.querySelector('.replay-response')?.textContent).toContain('"a": 1');
});

it('searches the response, navigates matches, and keeps the query across views', async () => {
  const user = userEvent.setup();
  render(<ResponseInspector flowId="response-1" raw={RAW} empty="no response" />);

  const find = screen.getByRole('button', { name: t('detail.findIn', { pane: t('detail.response') }) });
  expect(find.querySelector('svg')).toBeTruthy();
  await user.click(find);
  const input = screen.getByRole('searchbox', { name: t('detail.findIn', { pane: t('detail.response') }) });
  await user.type(input, 'HTTP');
  expect(document.querySelector('.response-inspector .detail-find-count')?.textContent).toBe('1/1');
  expect(document.querySelector('.replay-response mark.find-current')?.textContent).toBe('HTTP');

  await user.click(screen.getByRole('tab', { name: t('detail.view.raw') }));
  expect((input as HTMLInputElement).value).toBe('HTTP');
  expect(document.querySelector('.replay-response mark.find-current')?.textContent).toBe('HTTP');
});

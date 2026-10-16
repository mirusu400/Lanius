import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import { ProjectPicker } from './ProjectPicker';
import type { StartupDoctorReport } from './projects';
import { StartupDoctor } from './StartupDoctor';
import { renderWithI18n as render, t } from './test-utils';

afterEach(() => {
  cleanup();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

function shell(doctor: () => Promise<StartupDoctorReport>) {
  const invoke = vi.fn(async (command: string) => {
    if (command === 'run_doctor') return doctor();
    if (command === 'list_projects') return [];
    if (command === 'get_global_lockdown') return { enabled: false, forced: false };
    throw new Error(`unexpected command: ${command}`);
  });
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
  return invoke;
}

const healthy: StartupDoctorReport = {
  engine: '/Applications/Lanius.app/lanius-engine',
  report: {
    engine_version: '0.4.0',
    platform: 'Darwin 25.5.0 (arm64)',
    checks: [
      { id: 'runtime', status: 'ok', detail: 'Python 3.13.9, mitmproxy 13.0.0' },
      { id: 'ca', status: 'warn', detail: 'not created yet' },
      { id: 'proxy_port', status: 'error', detail: 'OSError: in use (other-tool (pid 7))', holder: 'other-tool (pid 7)' },
      { id: 'proxy_start', status: 'ok', detail: '140 ms' },
    ],
  },
  error: null,
  output: null,
  last_log: 'ERROR app.proxy: proxy port 127.0.0.1:8080 is unavailable',
};

it('shows each engine check with what to do about it', async () => {
  shell(async () => healthy);
  render(<StartupDoctor />);

  expect(await screen.findByText(t('startupDoctor.check.proxy_port'))).toBeTruthy();
  expect(screen.getByText(`${t('startupDoctor.hint.proxyPort')} OSError: in use (other-tool (pid 7))`)).toBeTruthy();
  expect(screen.getByText(`${t('startupDoctor.hint.caMissing')} not created yet`)).toBeTruthy();
  expect(screen.getByText('140 ms')).toBeTruthy();
  expect(screen.getByText(t('startupDoctor.lastLog'))).toBeTruthy();
  expect(screen.getByText(/proxy port 127\.0\.0\.1:8080 is unavailable/)).toBeTruthy();
});

it('reports an engine that could not run its checks, with its output', async () => {
  shell(async () => ({
    engine: '/opt/lanius-engine',
    report: null,
    error: 'engine exited with exit status: 1 before reporting',
    output: 'ImportError: mitmproxy_rs',
    last_log: null,
  }));
  render(<StartupDoctor />);

  expect(await screen.findByText(
    t('startupDoctor.engineFailed', { message: 'engine exited with exit status: 1 before reporting' }),
  )).toBeTruthy();
  expect(screen.getByText('ImportError: mitmproxy_rs')).toBeTruthy();
});

it('runs from the project picker without opening a project', async () => {
  const invoke = shell(async () => healthy);
  const user = userEvent.setup();
  render(<ProjectPicker onOpen={vi.fn()} />);

  await user.click(screen.getByRole('button', { name: t('startup.doctor') }));
  expect(await screen.findByText(t('startupDoctor.check.runtime'))).toBeTruthy();
  const commands = invoke.mock.calls.map(([command]) => command);
  expect(commands).toContain('run_doctor');
  expect(commands.some((command) => /project/.test(command) && command !== 'list_projects')).toBe(false);

  await user.click(screen.getByRole('button', { name: t('doctor.runAgain') }));
  await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === 'run_doctor')).toHaveLength(2));
});

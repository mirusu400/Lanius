import { expect, it } from 'vitest';

import {
  SettingsImportError,
  inspectSettingsFile,
  settingsProjectName,
} from './settingsImport';

it('detects and summarizes native Lanius settings without capture', async () => {
  const file = new File([JSON.stringify({
    format: 'lanius-project',
    version: 1,
    scope: [{}, {}],
    settings: {
      match_replace_rules: JSON.stringify([{}, {}, {}]),
      proxy_listeners: JSON.stringify({ listeners: [{}, {}] }),
    },
  })], 'settings.lanius.json', { type: 'application/json' });

  await expect(inspectSettingsFile(file)).resolves.toMatchObject({
    source: 'lanius', scope: 2, matchReplace: 3, listeners: 2,
  });
});

it('detects and summarizes Burp settings', async () => {
  const file = new File([JSON.stringify({
    target: { scope: { include: [{}, {}], exclude: [{}] } },
    proxy: {
      match_replace_rules: [{}, {}],
      request_listeners: [{ running: true }, { running: false }],
    },
  })], 'demo_burp_config.json', { type: 'application/json' });

  await expect(inspectSettingsFile(file)).resolves.toMatchObject({
    source: 'burp', scope: 3, matchReplace: 2, listeners: 1,
  });
});

it('rejects a full Lanius capture from the settings-only path', async () => {
  const file = new File([
    JSON.stringify({ format: 'lanius-project', version: 1, flows: [] }),
  ], 'full.json', { type: 'application/json' });
  await expect(inspectSettingsFile(file)).rejects.toMatchObject<Partial<SettingsImportError>>({
    key: 'project.settingsFileHasCapture',
  });
});

it('rejects a Burp export that contains no settings Lanius can apply', async () => {
  const file = new File([
    JSON.stringify({ repeater: { follow_redirections: true } }),
  ], 'repeater-only.json', { type: 'application/json' });
  await expect(inspectSettingsFile(file)).rejects.toMatchObject<Partial<SettingsImportError>>({
    key: 'project.settingsFileUnsupported',
  });
});

it('derives a unique startup project name from either settings filename', () => {
  expect(settingsProjectName('KT 웹사이트_burp_config.json', [])).toBe('KT 웹사이트');
  expect(settingsProjectName('lanius-settings-demo.lanius.json', ['demo'])).toBe('demo (2)');
});

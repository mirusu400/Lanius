import { useEffect, useState } from 'react';

import { DashboardTab } from './tabs/DashboardTab';
import { ProxyTab } from './tabs/ProxyTab';
import { RepeaterTabView } from './tabs/RepeaterTab';
import { TargetTab } from './tabs/TargetTab';
import { IntruderTab } from './tabs/IntruderTab';
import { DecoderTab } from './tabs/DecoderTab';
import { ComparerTab } from './tabs/ComparerTab';
import { PluginsTab } from './tabs/PluginsTab';
import { LoggerTab } from './tabs/LoggerTab';
import { SettingsTab } from './tabs/SettingsTab';
import { DocsTab } from './tabs/DocsTab';
import { useT } from './i18n';
import { autosave } from './tabs/autosave';
import { getTabs, setTabs, subscribe as subscribeRepeater } from './tabs/repeaterStore';
import {
  getDecoderTabs,
  setDecoderTabs,
  subscribe as subscribeDecoder,
} from './tabs/decoderStore';
import './App.css';

const TABS = [
  'Dashboard',
  'Proxy',
  'Target',
  'Repeater',
  'Intruder',
  'Decoder',
  'Comparer',
  'Logger',
  'Plugins',
  'Settings',
  'Docs',
] as const;

export type Tab = (typeof TABS)[number];

export default function App() {
  const t = useT();
  const [tab, setTab] = useState<Tab>('Dashboard');

  // Persist what you were working on, so closing Lanius does not throw
  // away your open requests.
  useEffect(() => {
    const stop = [
      autosave('repeater', (listener) => subscribeRepeater(() => listener(getTabs())), setTabs),
      autosave(
        'decoder',
        (listener) => subscribeDecoder(() => listener(getDecoderTabs())),
        setDecoderTabs,
      ),
    ];
    return () => stop.forEach((fn) => fn());
  }, []);

  return (
    <div className="app">
      <header className="titlebar">
        <button
          type="button"
          className={tab === 'Dashboard' ? 'brand active' : 'brand'}
          onClick={() => setTab('Dashboard')}
          aria-label={t('dash.home')}
        >
          Lanius
        </button>
        <nav className="tabs">
          {TABS.map((name) => (
            <button
              key={name}
              className={name === tab ? 'tab active' : 'tab'}
              onClick={() => setTab(name)}
            >
              {name === 'Dashboard' ? t('dash.title') : name === 'Docs' ? t('docs.title') : name}
            </button>
          ))}
        </nav>
      </header>
      <main className="content">
        {tab === 'Dashboard' ? (
          <DashboardTab onOpenTab={(next) => setTab(next as Tab)} />
        ) : tab === 'Proxy' ? (
          <ProxyTab />
        ) : tab === 'Target' ? (
          <TargetTab />
        ) : tab === 'Repeater' ? (
          <RepeaterTabView />
        ) : tab === 'Intruder' ? (
          <IntruderTab />
        ) : tab === 'Decoder' ? (
          <DecoderTab />
        ) : tab === 'Comparer' ? (
          <ComparerTab />
        ) : tab === 'Plugins' ? (
          <PluginsTab />
        ) : tab === 'Logger' ? (
          <LoggerTab />
        ) : tab === 'Settings' ? (
          <SettingsTab />
        ) : tab === 'Docs' ? (
          <DocsTab />
        ) : null}
      </main>
    </div>
  );
}

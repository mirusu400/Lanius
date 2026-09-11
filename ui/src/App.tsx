import { useState } from 'react';

import { ProxyTab } from './tabs/ProxyTab';
import { RepeaterTabView } from './tabs/RepeaterTab';
import { TargetTab } from './tabs/TargetTab';
import { IntruderTab } from './tabs/IntruderTab';
import { DecoderTab } from './tabs/DecoderTab';
import { ComparerTab } from './tabs/ComparerTab';
import { PluginsTab } from './tabs/PluginsTab';
import { LoggerTab } from './tabs/LoggerTab';
import { SettingsTab } from './tabs/SettingsTab';
import './App.css';

const TABS = [
  'Proxy',
  'Target',
  'Repeater',
  'Intruder',
  'Decoder',
  'Comparer',
  'Logger',
  'Plugins',
  'Settings',
] as const;

type Tab = (typeof TABS)[number];

export default function App() {
  const [tab, setTab] = useState<Tab>('Proxy');

  return (
    <div className="app">
      <header className="titlebar">
        <span className="brand">Lanius</span>
        <nav className="tabs">
          {TABS.map((name) => (
            <button
              key={name}
              className={name === tab ? 'tab active' : 'tab'}
              onClick={() => setTab(name)}
            >
              {name}
            </button>
          ))}
        </nav>
      </header>
      <main className="content">
        {tab === 'Proxy' ? (
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
        ) : null}
      </main>
    </div>
  );
}

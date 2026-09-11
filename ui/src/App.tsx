import { useState } from 'react';

import { ProxyTab } from './tabs/ProxyTab';
import { RepeaterTabView } from './tabs/RepeaterTab';
import { TargetTab } from './tabs/TargetTab';
import { IntruderTab } from './tabs/IntruderTab';
import { DecoderTab } from './tabs/DecoderTab';
import { ComparerTab } from './tabs/ComparerTab';
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

const ROADMAP: Record<string, string> = {
  Logger: 'M1+ — 전체 이벤트 로그',
  Plugins: 'M7 — 플러그인 시스템',
  Settings: 'M1+ — CA 내보내기, 프록시 설정',
};

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
        ) : (
          <div className="placeholder">
            <h2>{tab}</h2>
            <p className="muted">{ROADMAP[tab]}</p>
          </div>
        )}
      </main>
    </div>
  );
}

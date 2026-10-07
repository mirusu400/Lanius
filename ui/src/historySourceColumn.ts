import { useEffect, useState } from 'react';

const KEY = 'lanius.history.showLocalSourceIp';
const EVENT = 'lanius-history-source-column';

export function showLocalSourceIpColumn(): boolean {
  try { return window.localStorage.getItem(KEY) === '1'; }
  catch { return false; }
}

export function setShowLocalSourceIpColumn(value: boolean): void {
  try { window.localStorage.setItem(KEY, value ? '1' : '0'); }
  catch { /* The current window still updates. */ }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: value }));
}

export function useLocalSourceIpColumn(): boolean {
  const [visible, setVisible] = useState(showLocalSourceIpColumn);
  useEffect(() => {
    const changed = (event: Event) => setVisible((event as CustomEvent<boolean>).detail);
    const storage = () => setVisible(showLocalSourceIpColumn());
    window.addEventListener(EVENT, changed);
    window.addEventListener('storage', storage);
    return () => {
      window.removeEventListener(EVENT, changed);
      window.removeEventListener('storage', storage);
    };
  }, []);
  return visible;
}

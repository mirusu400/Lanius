import { createContext, useContext, type ReactNode } from 'react';
import type { PluginInfo, PluginUiView } from '../api/types';

export interface View { key: string; plugin: PluginInfo; view: PluginUiView }
export interface Request { plugin: string; view: string; mode: 'tab' | 'dialog'; context?: Record<string, unknown> }
interface Workspace {
  tabs: View[];
  active: string | null;
  select: (key: string | null) => void;
  content: ReactNode;
}
export const PluginWorkspaceContext = createContext<Workspace>({ tabs: [], active: null, select: () => undefined, content: null });

/** Only the owner of an action can open one of its declared sandboxed views. */
export function openPluginActionView(plugin: string, result: unknown) {
  if (!result || typeof result !== 'object' || !('ui' in result)) return;
  const ui = result.ui as Partial<Request> | null;
  if (!ui || typeof ui.view !== 'string' || !['tab', 'dialog'].includes(String(ui.mode))) return;
  window.dispatchEvent(new CustomEvent('lanius.openPluginView', {
    detail: { ...ui, plugin },
  }));
}

export function usePluginWorkspace() { return useContext(PluginWorkspaceContext); }

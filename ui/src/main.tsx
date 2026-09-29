import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { I18nProvider } from './i18n'
import { apply, load } from './appearance'
import { syncApiBaseWithShell } from './api/client'
import { ToastProvider } from './components/Toast'

// Before the first paint: otherwise the window flashes the default theme
// and then snaps to the chosen one on launch.
apply(load())

// The shell may have saved a non-default API/MCP port. Resolve it before
// any tab starts polling or opens a WebSocket.
async function start() {
  try {
    await syncApiBaseWithShell()
  } catch {
    // The project picker can still explain a shell startup failure.
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <I18nProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </I18nProvider>
    </StrictMode>,
  )
}

void start()

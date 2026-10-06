import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // The engine's Origin allowlist is deliberately exact. Do not silently
  // move to a port that it must (correctly) reject.
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // The app bundles the same Markdown files that the website reads.
    fs: { allow: ['..'] },
  },
  plugins: [react()],
})

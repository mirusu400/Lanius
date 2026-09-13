import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: false,
    // The default forks pool intermittently times out spawning workers on
    // this suite, which silently reports far fewer tests than exist.
    pool: 'threads',
    setupFiles: ['./src/test-setup.ts'],
  },
});

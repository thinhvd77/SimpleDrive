import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: '**/ui.spec.ts', workers: 1,
  use: { baseURL: 'http://127.0.0.1:4173', channel: 'msedge', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: 'npm run preview:local', url: 'http://127.0.0.1:4173/api/health', reuseExistingServer: true, timeout: 60_000 },
});

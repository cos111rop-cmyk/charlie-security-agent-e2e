import { defineConfig } from '@playwright/test';

const useMock = process.env.USE_MOCK_AGENT !== 'false';

export default defineConfig({
  testDir: './tests',
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.AGENT_WS_URL || 'ws://127.0.0.1:8080',
  },
  webServer: useMock
    ? {
        command: 'npx tsx mock-server/server.ts',
        port: 8080,
        reuseExistingServer: !process.env.CI,
        timeout: 15_000,
      }
    : undefined,
});

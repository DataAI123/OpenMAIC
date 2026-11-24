import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/enterprise',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'https://localhost:3002',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  webServer: {
    command: 'pnpm start',
    url: 'https://localhost:3002/api/auth/session',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});

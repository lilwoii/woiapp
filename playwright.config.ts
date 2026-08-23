import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/web-e2e',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    colorScheme: 'light',
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 5'] } },
  ],
  webServer: [
    {
      command: 'node scripts/serve-static-dist.mjs',
      env: { SPOTTR_E2E_PORT: '4173', SPOTTR_E2E_ROOT: 'dist/client' },
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: !process.env.CI,
      timeout: 20_000,
    },
    {
      command: 'node scripts/serve-static-dist.mjs',
      env: { SPOTTR_E2E_PORT: '4174', SPOTTR_E2E_ROOT: 'dist-e2e' },
      url: 'http://127.0.0.1:4174',
      reuseExistingServer: !process.env.CI,
      timeout: 20_000,
    },
  ],
});

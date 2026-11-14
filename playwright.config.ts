import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  retries: 0,
  webServer: {
    command: 'npm run preview',
    port: 4173,
    reuseExistingServer: true,
  },
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'Mobile Pixel',
      use: {
        ...devices['Pixel 5'],
        permissions: ['camera'],
        launchOptions: {
          args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
        },
      },
    },
    {
      name: 'Mobile iPhone',
      use: {
        ...devices['iPhone 13'],
        defaultBrowserType: 'chromium',
      },
    },
    {
      name: 'Desktop Chrome',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        permissions: ['camera'],
        launchOptions: {
          args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
        },
      },
    },
  ],
});

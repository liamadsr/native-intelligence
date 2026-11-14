import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const IS_CI = !!process.env.CI;

export default defineConfig({
  testDir: './e2e/tests',
  outputDir: './e2e/.results',

  fullyParallel: true,
  forbidOnly: IS_CI,
  retries: IS_CI ? 2 : 0,
  workers: IS_CI ? 4 : undefined,

  reporter: IS_CI
    ? [
        ['github'],
        ['html', { outputFolder: 'e2e/.report', open: 'never' }],
        ['json', { outputFile: 'e2e/.results/results.json' }],
      ]
    : [['list'], ['html', { outputFolder: 'e2e/.report', open: 'never' }]],

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'setup',
      testMatch: /global-setup\.ts/,
    },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
      // The sign-out journey runs in its own project (below) after this one.
      testIgnore: /09-signout\.spec\.ts/,
    },
    {
      // Sign-out revokes the shared alice session server-side. The route is
      // scoped to the current session (scope: 'local'), but if that ever
      // regresses to a global revoke, running this journey while the parallel
      // pack is mid-flight kills every worker's session (the 1-in-6 401
      // flake). Sequencing it after 'chromium' keeps it isolated either way.
      name: 'signout',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['chromium'],
      testMatch: /09-signout\.spec\.ts/,
    },
  ],
});

import { defineConfig, devices } from '@playwright/test'
export default defineConfig({
  testDir: '.', testMatch: '*.spec.ts', outputDir: '../.results/browser-decisions',
  use: { ...devices['Desktop Chrome'], headless: true }, workers: 1, reporter: 'list',
})

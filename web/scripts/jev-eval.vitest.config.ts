import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Separate from the default suite and build: these tests make paid Gateway calls
// only when the caller also sets JEV_LIVE_EVAL=1 and supplies credentials.
export default defineConfig({
  root: fileURLToPath(new URL('../', import.meta.url)),
  test: {
    environment: 'node',
    include: ['scripts/jev-decisions.live.test.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
    retry: 0,
    env: { NODE_ENV: 'test' },
  },
  resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
})

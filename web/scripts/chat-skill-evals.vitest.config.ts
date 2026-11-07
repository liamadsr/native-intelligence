import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Separate from the default suite and the build: these tests drive real chat
// turns against the local DEV stack (one paid chat turn per case), and only
// when the caller also sets CHAT_SKILL_EVAL=1.
export default defineConfig({
  root: fileURLToPath(new URL('../', import.meta.url)),
  test: {
    environment: 'node',
    include: ['scripts/chat-skill-evals.live.test.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
    retry: 0,
    env: { NODE_ENV: 'test' },
  },
  resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
})

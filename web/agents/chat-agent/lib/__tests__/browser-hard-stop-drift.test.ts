import { describe, expect, it } from 'vitest'
import { BROWSER_TASK_HARD_STOP_REASONS } from '@/lib/browser-agent/task-instructions'
import { HARD_STOP_REASONS } from '../browser-permission-handoff'

// The agent cannot import app modules at runtime, so it keeps a copy. If the
// copies drift, the task card and `next` guidance disagree with the handoff.
describe('browser hard-stop reasons', () => {
  it('match the app list exactly', () => {
    expect([...HARD_STOP_REASONS].sort()).toEqual([...BROWSER_TASK_HARD_STOP_REASONS].sort())
  })
})

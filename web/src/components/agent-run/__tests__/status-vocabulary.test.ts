import { describe, it, expect } from 'vitest'

/**
 * The single-source-of-truth run-status vocabulary (W1's src/lib/agent-run/types.ts)
 * as consumed by the interactive-work-run UI. The load-bearing fact for Loops v3
 * Phase 3: `needs_input` (a mid-run question park) is LIVE and cancelable, NOT
 * terminal — so a parked run keeps polling and can still be Stopped, and never
 * degrades into the "failed" bucket the way an unknown status does.
 */
import {
  AGENT_RUN_LIVE_STATUSES,
  AGENT_RUN_TERMINAL_STATUSES,
  isAgentRunLive,
  isAgentRunTerminal,
} from '@/lib/agent-run/types'
import {
  isCancelable,
  isLive,
  STATUS_META,
} from '@/app/account/(dashboard)/views/agent-run-ui'

describe('agent-run status vocabulary', () => {
  it('classifies needs_input as live, not terminal', () => {
    expect(isAgentRunLive('needs_input')).toBe(true)
    expect(isAgentRunTerminal('needs_input')).toBe(false)
  })

  it('lists needs_input in the LIVE set and not the TERMINAL set', () => {
    expect(AGENT_RUN_LIVE_STATUSES).toContain('needs_input')
    expect(AGENT_RUN_TERMINAL_STATUSES).not.toContain('needs_input')
  })

  it('treats queued/running/needs_input/canceling as live', () => {
    for (const s of ['queued', 'running', 'needs_input', 'canceling']) {
      expect(isAgentRunLive(s)).toBe(true)
    }
  })

  it('treats completed/failed/canceled/pr_open as terminal (not live)', () => {
    for (const s of ['completed', 'failed', 'canceled', 'pr_open']) {
      expect(isAgentRunTerminal(s)).toBe(true)
      expect(isAgentRunLive(s)).toBe(false)
    }
  })
})

describe('agent-run-ui status helpers', () => {
  it('isLive(needs_input) is true — the drill-in keeps polling a parked run', () => {
    expect(isLive('needs_input')).toBe(true)
  })

  it('isCancelable(needs_input) is true — Stop is still offered on a parked run', () => {
    expect(isCancelable('needs_input')).toBe(true)
    // queued/running remain cancelable; canceling (mid-teardown) does not.
    expect(isCancelable('queued')).toBe(true)
    expect(isCancelable('running')).toBe(true)
    expect(isCancelable('canceling')).toBe(false)
    expect(isCancelable('completed')).toBe(false)
  })

  it('STATUS_META has an amber, pulsing needs_input entry', () => {
    const meta = STATUS_META.needs_input
    expect(meta).toBeDefined()
    expect(meta.label).toBe('Needs your input')
    expect(meta.pulse).toBe(true)
    expect(meta.spin).toBeUndefined()
    expect(meta.tone).toContain('amber')
  })
})

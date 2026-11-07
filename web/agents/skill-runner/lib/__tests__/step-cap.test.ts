// Lives in lib/__tests__/ (not hooks/__tests__/): eve's hook discovery treats
// every path segment under hooks/ as a hook name.
import { describe, it, expect, vi } from 'vitest'
import stepCap, { SKILL_RUN_MAX_STEPS, STEP_CAP_MESSAGE } from '../../hooks/step-cap'
import { SKILL_RUN_MAX_STEPS as SERVER_MAX_STEPS } from '@/lib/flows/run-skill-eve'

type Ctx = { session: { id: string }; cancel: () => void }
type Hook = { events: Record<string, (e: unknown, ctx: Ctx) => Promise<void>> }
const hook = stepCap as unknown as Hook
const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
/** Whether the hook cancelled the turn (eve 0.68+ ignores a hook throw; the stop is ctx.cancel()). */
async function cancels(event: unknown): Promise<boolean> {
  const cancel = vi.fn()
  await hook.events['step.started'](event, { session: { id: 'sess-1' }, cancel })
  return cancel.mock.calls.length === 1
}
const started = (stepIndex: number) => ({ type: 'step.started', data: { stepIndex, modelId: 'm', sequence: 1, turnId: 't' } })

describe('skill-runner step-cap hook (main: stopWhen isStepCount(12))', () => {
  it('matches the server cap', () => {
    expect(SKILL_RUN_MAX_STEPS).toBe(12)
    expect(SKILL_RUN_MAX_STEPS).toBe(SERVER_MAX_STEPS)
  })

  it('lets steps 1-12 run and cancels the 13th model call before it starts, without throwing', async () => {
    for (let i = 0; i < SKILL_RUN_MAX_STEPS; i++) {
      expect(await cancels(started(i))).toBe(false)
    }
    warn.mockClear()
    expect(await cancels(started(12))).toBe(true)
    expect(warn).toHaveBeenCalledWith('[skill-runner] step-cap: cancelling the turn', { sessionId: 'sess-1', reason: STEP_CAP_MESSAGE })
  })

  it('ignores an event without a numeric stepIndex', async () => {
    expect(await cancels({})).toBe(false)
  })
})

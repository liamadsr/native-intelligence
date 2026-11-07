/**
 * shadowNudgeWorth (nudge-worth-shadow.ts): returns at once, runs its work in
 * Next's after(), skips eval captures, and never throws. The route-level
 * proof (after delivery, not awaited, stale drops never asked) is in
 * src/app/api/internal/live-agent/tool/__tests__/route.test.ts.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({ after: [] as unknown[] }))
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (work: unknown) => { h.after.push(work) },
}))

const { shadowNudgeWorth } = await import('../nudge-worth-shadow')

const args = (over: Partial<Parameters<typeof shadowNudgeWorth>[0]> = {}) => ({
  supabase: {} as SupabaseClient,
  userId: 'u1',
  workspaceId: 'w1',
  captureId: 'c1',
  isEvalCapture: false,
  nudge: { id: 'n1', message: 'Ask for a start date.', kind: 'suggestion' as const },
  recent: 'Priya: soon',
  ...over,
})

describe('shadowNudgeWorth', () => {
  it('hands its work to after() and returns before it runs', async () => {
    h.after = []
    const decide = vi.fn(async () => 'send')
    const loadContext = vi.fn(async () => ({ goal: 'Pilot date', alreadyTold: ['Earlier.'] }))
    expect(shadowNudgeWorth(args(), { decide, loadContext })).toBeUndefined()
    expect(h.after).toHaveLength(1)
    await h.after[0]
    expect(decide).toHaveBeenCalledWith(
      { nudge: 'Ask for a start date.', kind: 'suggestion', goal: 'Pilot date', alreadyTold: ['Earlier.'], recent: 'Priya: soon' },
      expect.objectContaining({ captureId: 'c1', nudge: expect.objectContaining({ id: 'n1' }) }),
    )
  })

  it('skips an eval capture entirely: no reads, no Jev, nothing deferred', () => {
    const defer = vi.fn()
    const decide = vi.fn()
    const loadContext = vi.fn()
    shadowNudgeWorth(args({ isEvalCapture: true }), { defer, decide, loadContext })
    expect(defer).not.toHaveBeenCalled()
    expect(loadContext).not.toHaveBeenCalled()
    expect(decide).not.toHaveBeenCalled()
  })

  it('clips long text inside the task schema, and a failure is one log line', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let work: Promise<unknown> | undefined
    const decide = vi.fn(async () => { throw new Error('jev down') })
    shadowNudgeWorth(args({ nudge: { id: 'n2', message: 'x'.repeat(9000), kind: 'insight' }, recent: undefined }), {
      defer: (w) => { work = w },
      loadContext: async () => ({ goal: null, alreadyTold: Array(20).fill('y'.repeat(5000)) }),
      decide,
    })
    await work
    const input = (decide.mock.calls[0] as unknown[])[0] as { nudge: string; alreadyTold: string[]; recent: unknown }
    expect(input.nudge).toHaveLength(2000)
    expect(input.alreadyTold).toHaveLength(10)
    expect(input.alreadyTold.every((t) => t.length === 2000)).toBe(true)
    expect(input.recent).toBeNull()
    expect(warn).toHaveBeenCalledExactlyOnceWith('[live-agent] nudge.worth shadow skipped:', 'jev down')
    warn.mockRestore()
  })
})

/**
 * The role's circuit breaker as one reading (role-breaker.ts): the auto-attempt
 * gate refuses on it (auto-attempt.test.ts, "the role breaker") and the Agents
 * page's roster shows it. These pin the reading itself: which rows count and
 * when it opens.
 */
import { describe, it, expect } from 'vitest'
import { makeFakeSupabase } from './fake-supabase'
import { roleBreakerState, type RoleBreakerPolicy } from '../role-breaker'

const NOW = new Date('2026-09-27T12:00:00.000Z')
const DAY = 86_400_000
const POLICY: RoleBreakerPolicy = { role_breaker_window: 3, role_breaker_quiet_days: 7, role_breaker_resumed_at: {} }

function attempt(id: string, daysAgo: number, review: string | null, over: Record<string, unknown> = {}) {
  return {
    id,
    workspace_id: 'w1',
    origin: 'attempt',
    ai_team_member_id: 'tm-researcher',
    progress: review ? { review } : {},
    created_at: new Date(NOW.getTime() - daysAgo * DAY).toISOString(),
    ...over,
  }
}

const args = (policy: RoleBreakerPolicy = POLICY) => ({
  workspaceId: 'w1',
  role: 'researcher' as const,
  teammateIds: ['tm-researcher'],
  policy,
  now: NOW,
})

describe('roleBreakerState', () => {
  it('opens when the last N attempts inside the quiet period were all dismissed', async () => {
    const fake = makeFakeSupabase()
    fake.seed('tracked_job', [attempt('a', 1, 'dismissed'), attempt('b', 2, 'dismissed'), attempt('c', 3, 'dismissed')])
    expect(await roleBreakerState(fake as never, args())).toEqual({
      open: true,
      window: 3,
      since: new Date(NOW.getTime() - 7 * DAY).toISOString(),
    })
  })

  it('stays closed with fewer than N attempts, or when any of the last N was not dismissed', async () => {
    const fake = makeFakeSupabase()
    fake.seed('tracked_job', [attempt('a', 1, 'dismissed'), attempt('b', 2, 'dismissed')])
    expect(await roleBreakerState(fake as never, args())).toMatchObject({ open: false })

    const mixed = makeFakeSupabase()
    mixed.seed('tracked_job', [
      attempt('a', 1, 'dismissed'),
      attempt('b', 2, 'reviewed'),
      attempt('c', 3, 'dismissed'),
      attempt('d', 4, 'dismissed'),
    ])
    expect(await roleBreakerState(mixed as never, args())).toMatchObject({ open: false })
  })

  it('counts only attempts, only this workspace, only the role’s teammates', async () => {
    const fake = makeFakeSupabase()
    fake.seed('tracked_job', [
      attempt('a', 1, 'dismissed'),
      attempt('b', 2, 'dismissed'),
      attempt('user', 1, 'dismissed', { origin: 'user' }),
      attempt('other-ws', 1, 'dismissed', { workspace_id: 'w2' }),
      attempt('other-role', 1, 'dismissed', { ai_team_member_id: 'tm-writer' }),
    ])
    expect(await roleBreakerState(fake as never, args())).toMatchObject({ open: false })
  })

  it('ignores attempts older than the quiet period, or from before the role’s resume', async () => {
    const fake = makeFakeSupabase()
    fake.seed('tracked_job', [attempt('a', 1, 'dismissed'), attempt('b', 2, 'dismissed'), attempt('c', 8, 'dismissed')])
    expect(await roleBreakerState(fake as never, args())).toMatchObject({ open: false })

    const resumed = makeFakeSupabase()
    resumed.seed('tracked_job', [attempt('a', 1, 'dismissed'), attempt('b', 2, 'dismissed'), attempt('c', 3, 'dismissed')])
    const resumedAt = new Date(NOW.getTime() - 2.5 * DAY).toISOString()
    expect(
      await roleBreakerState(resumed as never, args({ ...POLICY, role_breaker_resumed_at: { researcher: resumedAt } })),
    ).toEqual({ open: false, window: 3, since: resumedAt })
  })

  it('is off with window 0 or no teammates, and reads nothing', async () => {
    const fake = makeFakeSupabase()
    fake.seed('tracked_job', [attempt('a', 1, 'dismissed')])
    expect(await roleBreakerState(fake as never, args({ ...POLICY, role_breaker_window: 0 }))).toEqual({ open: false, window: 0, since: null })
    expect(await roleBreakerState(fake as never, { ...args(), teammateIds: [] })).toEqual({ open: false, window: 3, since: null })
    expect(fake.calls).toHaveLength(0)
  })

  it('ignores loop rows: a role teammate fronting a loop is never paused by its dismissed cards (bots-v3 Phase 3)', async () => {
    const fake = makeFakeSupabase()
    fake.seed('tracked_job', [
      attempt('l1', 1, 'dismissed', { origin: 'loop' }),
      attempt('l2', 2, 'dismissed', { origin: 'loop' }),
      attempt('l3', 3, 'dismissed', { origin: 'loop' }),
      attempt('a1', 4, 'dismissed'),
    ])
    expect(await roleBreakerState(fake as never, args())).toMatchObject({ open: false })
  })
})

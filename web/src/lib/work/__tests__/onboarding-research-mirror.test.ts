/**
 * Onboarding research → the work ledger (Sequence row 6, plan §1.1). The row
 * starts with the eve session; the settle mirrors the member's STORED research
 * state for that session — the caller's word is only the session id.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeFakeSupabase } from './fake-supabase'

const hoisted = vi.hoisted(() => ({ createNotification: vi.fn(async () => {}) }))
vi.mock('@/lib/notifications', () => ({ createNotification: hoisted.createNotification }))
// The recorder wakes the agent router (and the home turn) through Inngest: mocked,
// so no test sends a real event (src/test/setup.ts fails any that slip through).
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn(async () => ({ ids: [] })) } }))
import { mirrorOnboardingResearchStarted, researchSummary, settleOnboardingResearchWork } from '../onboarding-research-mirror'

function seeded(research: Record<string, unknown> | null) {
  const fake = makeFakeSupabase({ unique: { tracked_job: ['kind,run_key'] } })
  fake.seed('member', [{ id: 'm1', workspace_id: 'w1', user_id: 'u1', onboarding_progress: research ? { research } : {} }])
  return fake
}
const row = (fake: ReturnType<typeof seeded>) => fake.rows('tracked_job')[0]

beforeEach(() => hoisted.createNotification.mockClear())

describe('onboarding research mirror', () => {
  it('starts one running row keyed by the session id', async () => {
    const fake = seeded(null)
    await mirrorOnboardingResearchStarted(fake as never, { workspaceId: 'w1', memberId: 'm1', sessionId: 'sess-1' })
    await mirrorOnboardingResearchStarted(fake as never, { workspaceId: 'w1', memberId: 'm1', sessionId: 'sess-1' })
    expect(fake.rows('tracked_job')).toHaveLength(1)
    expect(row(fake)).toMatchObject({
      kind: 'onboarding_research',
      status: 'running',
      member_id: 'm1',
      run_key: 'sess-1',
      title: 'Researching your company',
    })
  })

  it('settles done from the stored state, with what it set up', async () => {
    const fake = seeded({ sessionId: 'sess-1', status: 'done', companyFound: true, seededSummary: { projectName: 'Launch plan', actionCount: 4 } })
    await mirrorOnboardingResearchStarted(fake as never, { workspaceId: 'w1', memberId: 'm1', sessionId: 'sess-1' })
    expect(await settleOnboardingResearchWork(fake as never, 'sess-1')).toEqual({ settled: 'done' })
    expect(row(fake)).toMatchObject({ status: 'done', result_summary: 'Found your company; set up Launch plan with 4 actions' })
  })

  it('settles skipped as skipped', async () => {
    const fake = seeded({ sessionId: 'sess-1', status: 'skipped', companyFound: false })
    await mirrorOnboardingResearchStarted(fake as never, { workspaceId: 'w1', memberId: 'm1', sessionId: 'sess-1' })
    expect(await settleOnboardingResearchWork(fake as never, 'sess-1')).toEqual({ settled: 'skipped' })
    expect(row(fake)).toMatchObject({ status: 'skipped', skip_reason: 'No company profile found' })
  })

  it('refuses when the stored state is another session or not finished, and when there is no row', async () => {
    const other = seeded({ sessionId: 'sess-OTHER', status: 'done' })
    await mirrorOnboardingResearchStarted(other as never, { workspaceId: 'w1', memberId: 'm1', sessionId: 'sess-1' })
    expect(await settleOnboardingResearchWork(other as never, 'sess-1')).toEqual({ settled: null, reason: 'session_mismatch' })
    expect(row(other).status).toBe('running')

    const running = seeded({ sessionId: 'sess-1', status: 'running' })
    await mirrorOnboardingResearchStarted(running as never, { workspaceId: 'w1', memberId: 'm1', sessionId: 'sess-1' })
    expect(await settleOnboardingResearchWork(running as never, 'sess-1')).toEqual({ settled: null, reason: 'not_finished' })

    expect(await settleOnboardingResearchWork(seeded(null) as never, 'sess-9')).toEqual({ settled: null, reason: 'no_item' })
  })

  it('summarises without a seed', () => {
    expect(researchSummary({ companyFound: true })).toBe('Found your company')
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

/**
 * Drafting on arrival (src/lib/email/arrival-drafts.ts): past the kill switch
 * (failing closed), dormancy and usage; within the daily cap it shares with
 * the safety net; through the same generateEmailDrafts the daily pass uses;
 * and one finished Activity row per push that produced drafts.
 */

const hoisted = vi.hoisted(() => ({
  generateEmailDrafts: vi.fn(),
  checkUsageLimits: vi.fn(async (..._a: unknown[]): Promise<{ allowed?: boolean } | undefined> => ({ allowed: true })),
}))
vi.mock('@/lib/crm/email-drafts', () => ({ generateEmailDrafts: hoisted.generateEmailDrafts, MAX_DRAFTS_PER_PASS: 10, REPLY_DRAFT_LABEL: 'Reply draft' }))
vi.mock('@/lib/ai/auth', () => ({ checkUsageLimits: hoisted.checkUsageLimits }))
vi.mock('@/lib/notifications', () => ({ createNotification: vi.fn(async () => {}) }))

const { ARRIVAL_DRAFT_BUDGET_MS, AUTO_DRAFT_DAILY_CAP, SAFETY_NET_MARGIN_MS, dailyCapCheck, draftRepliesToNewMail, draftingBlocked, recordArrivalDrafts, remainingAutoDrafts } =
  await import('@/lib/email/arrival-drafts')
const { resetAgentRunMirrorCaches } = await import('@/lib/work/agent-run-mirror')

const W = '11111111-1111-4111-8111-000000000001'
const NOW = new Date('2026-10-14T21:00:00.000Z')
let db: FakeSupabase

const drafts = (n: number, createdAt: string) =>
  Array.from({ length: n }, (_, i) => ({ id: `d-${createdAt}-${i}`, user_id: 'u-1', workspace_id: W, created_at: createdAt, metadata: { origin: 'automatic' } }))

const NEW_DRAFT = { id: 'd-new', subject: 'Re: Pricing', email_thread_id: 'idx-1', created_at: '2026-10-14T21:00:01.000Z' }
/** What a pass returns (Inngest keeps it): ids only, never the subject. */
const NEW_DRAFT_IDS = { id: 'd-new', email_thread_id: 'idx-1', created_at: '2026-10-14T21:00:01.000Z' }

/** Gates open: the switch on, an active workspace, usage allowed. */
const OPEN = {
  readPaused: async () => 'active' as const,
  isDormant: async () => false,
  checkUsage: async () => ({ allowed: true }),
}

beforeEach(() => {
  db = makeFakeSupabase()
  resetAgentRunMirrorCaches()
  hoisted.generateEmailDrafts.mockReset().mockResolvedValue({ drafts: [NEW_DRAFT], count: 1 })
  hoisted.checkUsageLimits.mockReset().mockResolvedValue({ allowed: true })
})

describe('remainingAutoDrafts', () => {
  it("counts only today's drafts (UTC) for this person in this workspace", async () => {
    db.seed('email_draft', [
      ...drafts(3, '2026-10-14T08:00:00.000Z'),
      ...drafts(5, '2026-10-13T23:59:00.000Z'),
      { id: 'other-user', user_id: 'u-2', workspace_id: W, created_at: '2026-10-14T09:00:00.000Z' },
      { id: 'other-ws', user_id: 'u-1', workspace_id: 'ws-x', created_at: '2026-10-14T09:00:00.000Z' },
      // A draft the person asked for (a chat) never uses the automatic cap.
      { id: 'chat-1', user_id: 'u-1', workspace_id: W, created_at: '2026-10-14T09:00:00.000Z', metadata: { origin: 'chat' } },
      { id: 'explicit-1', user_id: 'u-1', workspace_id: W, created_at: '2026-10-14T09:00:00.000Z', metadata: { origin: 'explicit' } },
    ])
    expect(await remainingAutoDrafts(db as never, 'u-1', W, NOW)).toBe(AUTO_DRAFT_DAILY_CAP - 3)
  })

  it('the per-draft re-check says no once the shared cap is used, by either path', async () => {
    db.seed('email_draft', drafts(AUTO_DRAFT_DAILY_CAP - 1, '2026-10-14T08:00:00.000Z'))
    const check = dailyCapCheck(db as never, 'u-1', W, () => NOW)
    expect(await check()).toBe(true)
    // The safety net (or a concurrent arrival pass) writes the 20th.
    db.seed('email_draft', drafts(1, '2026-10-14T20:00:00.000Z'))
    expect(await check()).toBe(false)
  })

  it('a sent or dismissed draft still counts: today\'s email.drafted events outlive their deleted drafts', async () => {
    db.seed('agent_event', [
      ...Array.from({ length: 4 }, (_, i) => ({ id: `e-${i}`, user_id: 'u-1', workspace_id: W, kind: 'email.drafted', ref_id: `gone-${i}`, created_at: '2026-10-14T09:00:00.000Z' })),
      { id: 'e-dup', user_id: 'u-1', workspace_id: W, kind: 'email.drafted', ref_id: 'd-2026-10-14T08:00:00.000Z-0', created_at: '2026-10-14T09:00:00.000Z' },
      { id: 'e-old', user_id: 'u-1', workspace_id: W, kind: 'email.drafted', ref_id: 'old', created_at: '2026-10-13T09:00:00.000Z' },
      { id: 'e-other', user_id: 'u-1', workspace_id: W, kind: 'email.needs_reply', ref_id: 'x', created_at: '2026-10-14T09:00:00.000Z' },
    ])
    db.seed('email_draft', drafts(2, '2026-10-14T08:00:00.000Z'))
    // 4 deleted drafts + 2 still there (one also has its event): 6 today.
    expect(await remainingAutoDrafts(db as never, 'u-1', W, NOW)).toBe(AUTO_DRAFT_DAILY_CAP - 6)
  })

  it('the safety-net margin is two hours', () => {
    expect(SAFETY_NET_MARGIN_MS).toBe(2 * 60 * 60_000)
  })
})

describe('draftingBlocked (the gates both paths share)', () => {
  it('passes an active workspace whose person is within their usage limit', async () => {
    expect(await draftingBlocked(db as never, 'u-1', W, OPEN)).toBeNull()
  })

  it('a dormant workspace is refused; a failed dormancy read is not dormant', async () => {
    expect(await draftingBlocked(db as never, 'u-1', W, { ...OPEN, isDormant: async () => true })).toBe('dormant')
    expect(await draftingBlocked(db as never, 'u-1', W, { ...OPEN, isDormant: async () => { throw new Error('down') } })).toBeNull()
  })

  it('usage refuses on anything but an allowed row, as runDecision reads checkUsageLimits', async () => {
    expect(await draftingBlocked(db as never, 'u-1', W, { ...OPEN, checkUsage: async () => ({ allowed: false }) })).toBe('usage')
    expect(await draftingBlocked(db as never, 'u-1', W, { ...OPEN, checkUsage: async () => undefined })).toBe('usage')
    // checkUsageLimits throws a Response when over the limit or when billing is down.
    expect(await draftingBlocked(db as never, 'u-1', W, { ...OPEN, checkUsage: async () => { throw new Response(null, { status: 429 }) } })).toBe('usage')
  })

  it('defaults to checkUsageLimits for the person, opted in to the ChatGPT free tier', async () => {
    hoisted.checkUsageLimits.mockRejectedValueOnce(new Response(null, { status: 429 }))
    expect(await draftingBlocked(db as never, 'u-1', W, { isDormant: async () => false })).toBe('usage')
    expect(hoisted.checkUsageLimits).toHaveBeenCalledWith('u-1', undefined, { chatgptPlan: true })
    // A person on their own plan is let through: their drafts and decisions run on it.
    hoisted.checkUsageLimits.mockResolvedValueOnce({ allowed: true, reason: 'chatgpt_plan' } as never)
    expect(await draftingBlocked(db as never, 'u-1', W, { isDormant: async () => false })).toBeNull()
  })
})

describe('draftRepliesToNewMail', () => {
  it('drafts the given threads through the automatic reply gate, no more than are left today, re-checking the cap', async () => {
    db.seed('email_draft', drafts(AUTO_DRAFT_DAILY_CAP - 1, '2026-10-14T08:00:00.000Z'))
    // One slot left: generateEmailDrafts drafts one and stops with t2 untried.
    hoisted.generateEmailDrafts.mockResolvedValueOnce({ drafts: [NEW_DRAFT], count: 1, stoppedBy: 'max' })
    const result = await draftRepliesToNewMail(db as never, 'u-1', W, ['t1', 't2'], NOW, OPEN)
    expect(result).toEqual({ drafts: [NEW_DRAFT_IDS], blocked: 'cap' })
    expect(hoisted.generateEmailDrafts).toHaveBeenCalledWith('u-1', W, {
      thread_ids: ['t1', 't2'],
      max_drafts: 1,
      // No tone: the draft writes the way the person does (2026-10-17).
      replyIntent: 'automatic',
      allowAnother: expect.any(Function),
      deadlineAt: expect.any(Number),
    })
  })

  it('the pass has a deadline inside the Inngest step: its budget, from now, well under the route’s 600 s', async () => {
    const before = Date.now()
    await draftRepliesToNewMail(db as never, 'u-1', W, ['t1'], NOW, OPEN)
    const { deadlineAt } = hoisted.generateEmailDrafts.mock.calls.at(-1)![2] as { deadlineAt: number }
    expect(deadlineAt).toBeGreaterThanOrEqual(before + ARRIVAL_DRAFT_BUDGET_MS)
    expect(deadlineAt).toBeLessThanOrEqual(Date.now() + ARRIVAL_DRAFT_BUDGET_MS)
    // Room after the deadline for one unreviewed thread (a 45 s write and the gate) inside 600 s.
    expect(ARRIVAL_DRAFT_BUDGET_MS + 180_000).toBeLessThanOrEqual(600_000)
  })

  it('every thread tried → not capped, even when some were passed over by the reply gate', async () => {
    expect(await draftRepliesToNewMail(db as never, 'u-1', W, ['t1', 't2'], NOW, OPEN)).toEqual({ drafts: [NEW_DRAFT_IDS], blocked: null })
  })

  it('a pass the cap re-check stopped mid-way is capped', async () => {
    hoisted.generateEmailDrafts.mockResolvedValueOnce({ drafts: [], count: 0, stoppedBy: 'allowance' })
    expect(await draftRepliesToNewMail(db as never, 'u-1', W, ['t1'], NOW, OPEN)).toEqual({ drafts: [], blocked: 'cap' })
  })

  it('drafts nothing once the cap is reached', async () => {
    db.seed('email_draft', drafts(AUTO_DRAFT_DAILY_CAP, '2026-10-14T08:00:00.000Z'))
    expect(await draftRepliesToNewMail(db as never, 'u-1', W, ['t1'], NOW, OPEN)).toEqual({ drafts: [], blocked: 'cap' })
    expect(hoisted.generateEmailDrafts).not.toHaveBeenCalled()
  })

  it('drafts nothing for no threads', async () => {
    expect(await draftRepliesToNewMail(db as never, 'u-1', W, [], NOW, OPEN)).toEqual({ drafts: [], blocked: null })
    expect(hoisted.generateEmailDrafts).not.toHaveBeenCalled()
  })

  it('a paused workspace drafts nothing; a switch that cannot be read counts as paused (this spends money)', async () => {
    for (const state of ['paused', 'unknown'] as const) {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {})
      const result = await draftRepliesToNewMail(db as never, 'u-1', W, ['t1'], NOW, { ...OPEN, readPaused: async () => state })
      info.mockRestore()
      expect(result).toEqual({ drafts: [], blocked: 'paused' })
    }
    expect(hoisted.generateEmailDrafts).not.toHaveBeenCalled()
  })

  it('reads the real kill switch: autonomy off is paused', async () => {
    db.seed('workspace', [{ id: W, settings: { agent_autonomy: { mode: 'off' } } }])
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const result = await draftRepliesToNewMail(db as never, 'u-1', W, ['t1'], NOW, { isDormant: OPEN.isDormant, checkUsage: OPEN.checkUsage })
    info.mockRestore()
    expect(result.blocked).toBe('paused')
    expect(hoisted.generateEmailDrafts).not.toHaveBeenCalled()
  })

  it('a dormant workspace or a person over their usage limit drafts nothing', async () => {
    expect(await draftRepliesToNewMail(db as never, 'u-1', W, ['t1'], NOW, { ...OPEN, isDormant: async () => true })).toEqual({ drafts: [], blocked: 'dormant' })
    expect(await draftRepliesToNewMail(db as never, 'u-1', W, ['t1'], NOW, { ...OPEN, checkUsage: async () => ({ allowed: false }) })).toEqual({ drafts: [], blocked: 'usage' })
    expect(hoisted.generateEmailDrafts).not.toHaveBeenCalled()
  })
})

describe('recordArrivalDrafts', () => {
  beforeEach(() => {
    db.seed('member', [{ id: 'm-1', workspace_id: W, user_id: 'u-1' }])
  })

  it('writes one finished Activity row carrying the drafts', async () => {
    await recordArrivalDrafts(db as never, {
      userId: 'u-1',
      workspaceId: W,
      runKey: 'email-arrival-drafts:evt-1',
      drafts: [{ id: 'd-1', email_thread_id: null, created_at: null }],
    })
    const [row] = db.rows('tracked_job')
    expect(row).toMatchObject({
      kind: 'email_drafts',
      status: 'done',
      member_id: 'm-1',
      title: 'Reply draft for a new email',
      result_summary: '1 draft ready to review',
      run_key: 'email-arrival-drafts:evt-1',
      deliverables: [{ type: 'email_draft', id: 'd-1', label: 'Reply draft' }],
    })
    // No subject anywhere on the Activity row.
    expect(JSON.stringify(row)).not.toContain('Pricing')
  })

  it('counts several drafts in the title', async () => {
    await recordArrivalDrafts(db as never, {
      userId: 'u-1',
      workspaceId: W,
      runKey: 'email-arrival-drafts:evt-2',
      drafts: [
        { id: 'd-1', email_thread_id: null, created_at: null },
        { id: 'd-2', email_thread_id: null, created_at: null },
      ],
    })
    expect(db.rows('tracked_job')[0]).toMatchObject({ title: 'Reply drafts for 2 new emails', result_summary: '2 drafts ready to review' })
  })

  it('writes nothing when nothing was drafted', async () => {
    await recordArrivalDrafts(db as never, { userId: 'u-1', workspaceId: W, runKey: 'k', drafts: [] })
    expect(db.rows('tracked_job')).toHaveLength(0)
  })
})

describe('asked threads (E3)', () => {
  it('the ask skips become the asked list, each with the reason unsure', async () => {
    const { askedThreads, unsureReasons } = await import('../arrival-drafts')
    expect(askedThreads({ a: 'ask', b: 'no_reply', c: 'deferred', d: 'ask' })).toEqual(['a', 'd'])
    expect(askedThreads(undefined)).toEqual([])
    expect(unsureReasons(['a', 'd'])).toEqual({ a: 'unsure', d: 'unsure' })
    expect(unsureReasons([])).toBeUndefined()
  })
})

describe('turned-away threads (GEN-1164)', () => {
  it("the gate's no-reply skips are handed back, for the agent's understanding pass", async () => {
    const { turnedAwayThreads } = await import('../arrival-drafts')
    expect(turnedAwayThreads({ a: 'ask', b: 'no_reply', c: 'deferred', d: 'no_reply' })).toEqual(['b', 'd'])
    expect(turnedAwayThreads(undefined)).toEqual([])
    hoisted.generateEmailDrafts.mockResolvedValueOnce({ drafts: [], count: 0, skipped: { t1: 'no_reply', t2: 'ask', t3: 'deferred' } })
    expect(await draftRepliesToNewMail(db as never, 'u-1', W, ['t1', 't2', 't3'], NOW, OPEN)).toEqual({ drafts: [], blocked: null, asked: ['t2'], turnedAway: ['t1'] })
  })
})

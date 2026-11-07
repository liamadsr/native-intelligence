/**
 * Bots v3 1a: a verdict run's cards and digest name the teammate whose run it
 * was. deliverVerdictRun reads the teammate and the ledger row off the fire's
 * work handle, threads both into the apply walk (the cards' payload), and puts
 * the bot keys on the digest's metadata (bot-notice.ts) with the templated
 * sentence, and the digest speaks as the bot (1b): its title is the
 * teammate's name, its body the sentence. A run with no teammate
 * (a prose loop, an inert handle) sends exactly the digest it did.
 *
 * The apply walk, the notification writer and usage logging are mocked: this
 * isolates what deliverVerdictRun hands them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { WorkHandle } from '@/lib/work/recorder'
import type { RunVerdict } from '../verdict-apply'

const h = vi.hoisted(() => ({
  applyVerdict: vi.fn(),
  createNotification: vi.fn(async () => {}),
  recordVerdictTouches: vi.fn(async () => {}),
}))

vi.mock('eve/client', () => ({ Client: vi.fn(() => ({})) }))
vi.mock('@/lib/eve/task-session', () => ({ createTaskSession: vi.fn(), cancelTaskSession: vi.fn() }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/ai/system-prompt', () => ({ buildSystemPrompt: async () => '' }))
vi.mock('@/lib/ai/auth', () => ({ logUsage: async () => {} }))
vi.mock('../context-pack', () => ({ buildContextPack: async () => '' }))
vi.mock('@/lib/work/touch', () => ({ recordVerdictTouches: h.recordVerdictTouches }))
vi.mock('../verdict-apply', () => ({ applyVerdict: h.applyVerdict, resolveTrust: () => ({}) }))
vi.mock('@/lib/notifications', () => ({ createNotification: h.createNotification }))

const { deliverVerdictRun, decideVerdictNotification } = await import('../run-skill')

const TRUST = { auto_apply: false, min_confidence: 0.85, allow_external: false as const, max_cards_per_run: 3, outreach_draft_cards: true }
const SPEC = {
  runAsUserId: 'user-1',
  workspaceId: 'ws-1',
  skillId: 'skill-1',
  skillName: 'Proposal Triage',
  mode: 'report' as const,
  outputContract: 'verdict' as const,
  trust: TRUST,
  provenance: { skillName: 'Proposal Triage', captureTitle: 'Call with Acme', captureId: 'cap-1', flowId: 'flow-1' },
}
const VERDICT: RunVerdict = { decisions: [], needs_user: [], summary: 'Three need you.' }
const LEDGER = { summary: 'Three need you.', entries: [], cards_surfaced: 3, cards_overflow: 0, revoked_count: 0 }

/** member → the run-as member; ai_team_member → the teammate's name. */
function db() {
  const chain = (table: string) => {
    const c: Record<string, unknown> = {}
    for (const m of ['select', 'eq']) c[m] = () => c
    c.maybeSingle = async () => ({
      data: table === 'member' ? { id: 'm-1' } : table === 'ai_team_member' ? { name: 'Triage', role: null } : null,
      error: null,
    })
    return c
  }
  return { from: chain } as unknown as SupabaseClient
}

function handle(over: Partial<WorkHandle> = {}): WorkHandle {
  return { id: 'job-1', inert: false, aiTeamMemberId: 'tm-triage', kind: 'flow_run', workspaceId: 'ws-1', memberId: 'm-1', ...over } as WorkHandle
}

function deliver(work: WorkHandle | undefined) {
  return deliverVerdictRun({
    supabase: db(),
    spec: SPEC as never,
    runAsUserId: 'user-1',
    workspaceId: 'ws-1',
    fireId: 'evt-1',
    work,
    flowRunId: 'fr-1',
    captureTitle: 'Call with Acme',
    verdict: VERDICT,
    usage: { inputTokens: 0, outputTokens: 0 },
    costUsd: null,
    toolCalls: 0,
    steps: 0,
    durationMs: 0,
    actionId: 'a1',
    startedAt: Date.now(),
  })
}

function applyCtx(): Record<string, unknown> {
  return (h.applyVerdict.mock.calls.at(-1) as unknown[])[1] as Record<string, unknown>
}
function sent(): Record<string, unknown> {
  return (h.createNotification.mock.calls.at(-1) as unknown[])[0] as Record<string, unknown>
}

beforeEach(() => {
  h.applyVerdict.mockReset().mockResolvedValue({ ...LEDGER })
  h.createNotification.mockClear()
})

describe('deliverVerdictRun attribution', () => {
  it('hands the teammate and the ledger row to the apply walk (the cards name them)', async () => {
    await deliver(handle())
    expect(applyCtx()).toMatchObject({ teammateId: 'tm-triage', workItemId: 'job-1', flowId: 'flow-1', runKey: 'evt-1' })
  })

  it('puts the bot keys on the digest, which speaks as the bot: its name, then the template', async () => {
    await deliver(handle())
    const n = sent()
    expect(n.title).toBe('Triage')
    expect(n.body).toBe("I triaged 'Call with Acme': three proposals need you.")
    expect(n.type).toBe('flow_run_output')
    expect([n.targetType, n.targetId]).toEqual(['work_item', 'job-1'])
    expect(n.metadata).toEqual({
      teammate_id: 'tm-triage',
      teammate_name: 'Triage',
      sentence: "I triaged 'Call with Acme': three proposals need you.",
      work_item_id: 'job-1',
      capture_id: 'cap-1',
      card_count: 3,
    })
  })

  it('a run with no teammate sends exactly the digest it did, and the cards name no one', async () => {
    await deliver(handle({ aiTeamMemberId: null }))
    expect(applyCtx()).toMatchObject({ teammateId: null, workItemId: 'job-1' })
    expect(sent().metadata).toBeUndefined()
    const expected = decideVerdictNotification(LEDGER, 'Proposal Triage', undefined)!
    expect([sent().title, sent().body]).toEqual([expected.title, expected.body])
    expect(sent().title).toBe('Proposal Triage: 3 need you')
    expect([sent().targetType, sent().targetId]).toEqual(['work_item', 'job-1'])
  })

  it('an inert handle or none: no teammate, no work item, the flow_run deep link as before', async () => {
    await deliver(handle({ id: null, inert: true, aiTeamMemberId: null }))
    expect(applyCtx()).toMatchObject({ teammateId: null, workItemId: null })
    expect(sent().metadata).toBeUndefined()
    expect([sent().targetType, sent().targetId]).toEqual(['flow_run', 'fr-1'])

    await deliver(undefined)
    expect(applyCtx()).toMatchObject({ teammateId: null, workItemId: null })
    expect(sent().metadata).toBeUndefined()
  })

  it('a silent run (nothing needs you) sends nothing, teammate or not', async () => {
    h.applyVerdict.mockResolvedValue({ ...LEDGER, cards_surfaced: 0 })
    await deliver(handle())
    expect(h.createNotification).not.toHaveBeenCalled()
  })
})

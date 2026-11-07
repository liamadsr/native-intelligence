/**
 * The flywheel sweep (sweep.ts, run by src/lib/inngest/eval-flywheel.ts).
 * Pinned per stage:
 *   chat   only assistant messages in the window; one candidate per message
 *          per code (REPEATED_FAILURE, INPUT_INVALID), with the request from
 *          the earlier user message; a second pass records nothing twice;
 *          other errors are no candidate;
 *   loops  failed jobs in the window, minus the skip rules and the non-agent
 *          kinds; the owner is the job member's user; idempotent;
 *   both   page oldest first past SCAN_PAGE_SIZE rows; rows already recorded
 *          spend no budget; what RECORD_BUDGET leaves, the next pass takes;
 *   purge  dismissed after 30 days, new after 90, promoted and exported kept;
 *   the function: one step per stage, one counts-only log line.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { createStepMock } from '@/test/inngest-step-mock'
import { RECORD_BUDGET, SCAN_PAGE_SIZE, purgeCandidates, sweepChatFailures, sweepFailedJobs } from '../sweep'
import type { ChatTurnEvidence, LoopRunEvidence } from '../types'
import { assistantMessage, userMessage } from './fixtures'

const hoisted = vi.hoisted(() => ({ handler: null as null | ((ctx: { step: unknown }) => Promise<unknown>), db: null as unknown }))
vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: (_config: unknown, handler: (ctx: { step: unknown }) => Promise<unknown>) => {
      hoisted.handler = handler
      return {}
    },
  },
}))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => hoisted.db }))

const NOW = Date.parse('2026-10-16T12:00:00.000Z')
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString()
const WS = 'a1000000-0000-4000-8000-000000000001'
const USER = 'b1000000-0000-4000-8000-000000000001'
const CONV = 'c1000000-0000-4000-8000-000000000001'

let fake: FakeSupabase
const db = () => fake as unknown as SupabaseClient

beforeEach(() => {
  fake = makeFakeSupabase({ unique: { eval_candidate: ['dedupe_key'] } })
  hoisted.db = fake
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

const msg = (over: Record<string, unknown>) => ({ conversation_id: CONV, user_id: USER, workspace_id: WS, ...over })

describe('sweepChatFailures', () => {
  beforeEach(() => {
    fake.seed('chat_messages', [
      msg({ id: 'r1', role: 'user', ui_message: userMessage('Move ENG-1 to done'), ui_message_id: 'msg-u1', created_at: iso(31) }),
      msg({ id: 'r2', role: 'assistant', ui_message: assistantMessage('msg-a1'), ui_message_id: 'msg-a1', created_at: iso(30) }),
      // Out of the window.
      msg({ id: 'r3', role: 'assistant', ui_message: assistantMessage('msg-old'), ui_message_id: 'msg-old', created_at: iso(200) }),
      // An error, but not a sweep code.
      msg({
        id: 'r4',
        role: 'assistant',
        ui_message: { id: 'msg-a2', parts: [{ type: 'dynamic-tool', toolName: 'get_contact', state: 'output-error', input: {}, errorText: 'get_contact: gone [NOT_FOUND]' }] },
        ui_message_id: 'msg-a2',
        created_at: iso(10),
      }),
      // A clean turn.
      msg({ id: 'r5', role: 'assistant', ui_message: { id: 'msg-a3', parts: [{ type: 'text', text: 'Done.' }] }, ui_message_id: 'msg-a3', created_at: iso(5) }),
    ])
  })

  it('one candidate per message per code, with the request and the tool path', async () => {
    const counts = await sweepChatFailures(db(), NOW)
    expect(counts).toMatchObject({ found: 2, inserted: 2, known: 0, failed: 0 })
    const rows = fake.rows('eval_candidate')
    expect(rows.map((r) => [r.source, r.dedupe_key]).sort()).toEqual([
      ['input_invalid', 'chat:msg-a1:INPUT_INVALID'],
      ['repeated_failure', 'chat:msg-a1:REPEATED_FAILURE'],
    ])
    for (const row of rows) {
      expect(row).toMatchObject({ workspace_id: WS, user_id: USER, conversation_id: CONV, ref_type: 'chat_message', ref_id: 'msg-a1', polarity: 'bad', status: 'new', skill_slugs: ['triage'] })
      expect((row.evidence as ChatTurnEvidence).request).toBe('Move ENG-1 to done')
    }
  })

  it('a second pass over the same window records nothing twice', async () => {
    await sweepChatFailures(db(), NOW)
    const again = await sweepChatFailures(db(), NOW + 30 * 60_000)
    expect(again).toMatchObject({ found: 2, inserted: 0, known: 2 })
    expect(fake.rows('eval_candidate')).toHaveLength(2)
  })

  it('a reviewed candidate is left alone by a later pass', async () => {
    await sweepChatFailures(db(), NOW)
    for (const r of fake.rows('eval_candidate')) r.status = 'dismissed'
    await sweepChatFailures(db(), NOW)
    expect(fake.rows('eval_candidate').every((r) => r.status === 'dismissed')).toBe(true)
  })

  it('nothing in the window: no writes', async () => {
    expect(await sweepChatFailures(db(), NOW + 24 * 60 * 60_000)).toMatchObject({ scanned: 0, found: 0, inserted: 0 })
    expect(fake.rows('eval_candidate')).toHaveLength(0)
  })
})

describe('sweepFailedJobs', () => {
  beforeEach(() => {
    fake.seed('member', [{ id: 'mem-1', user_id: USER }])
    fake.seed('tracked_job', [
      { id: 'job-1', workspace_id: WS, member_id: 'mem-1', kind: 'flow_run', title: 'Triage', status: 'failed', error_message: 'model timed out', source: {}, finished_at: iso(20) },
      { id: 'job-2', workspace_id: WS, member_id: 'mem-1', kind: 'flow_run', title: 'Triage', status: 'failed', error_message: 'Usage limit reached for user x', source: {}, finished_at: iso(20) },
      { id: 'job-3', workspace_id: WS, member_id: 'mem-1', kind: 'crm_enrichment', title: 'Enrich', status: 'failed', error_message: 'Exa 500', source: {}, finished_at: iso(20) },
      { id: 'job-4', workspace_id: WS, member_id: 'mem-1', kind: 'work_run', title: 'Draft', status: 'canceled', error_message: null, source: {}, finished_at: iso(20) },
      { id: 'job-5', workspace_id: WS, member_id: 'mem-1', kind: 'work_run', title: 'Old', status: 'failed', error_message: 'boom', source: {}, finished_at: iso(300) },
      { id: 'job-6', workspace_id: WS, member_id: 'mem-gone', kind: 'work_run', title: 'Orphan', status: 'failed', error_message: 'boom', source: {}, finished_at: iso(10) },
    ])
  })

  it('records the failures that count, owned by the job member’s user', async () => {
    const counts = await sweepFailedJobs(db(), NOW)
    expect(counts).toMatchObject({ scanned: 4, found: 2, inserted: 1, passed: 3 })
    const rows = fake.rows('eval_candidate')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ source: 'loop_failed', dedupe_key: 'job:job-1', ref_type: 'tracked_job', ref_id: 'job-1', user_id: USER, workspace_id: WS })
    expect(rows[0].evidence as LoopRunEvidence).toMatchObject({ kind: 'loop_run', jobKind: 'flow_run', error: 'model timed out' })
  })

  it('is idempotent across overlapping passes', async () => {
    await sweepFailedJobs(db(), NOW)
    const again = await sweepFailedJobs(db(), NOW)
    expect(again).toMatchObject({ inserted: 0, known: 1 })
    expect(fake.rows('eval_candidate')).toHaveLength(1)
  })
})

describe('a busy window (more rows than one read)', () => {
  const invalid = (id: string) => ({
    id,
    role: 'assistant',
    parts: [{ type: 'dynamic-tool', toolName: 'list_actions', state: 'output-error', input: {}, errorText: 'list_actions: bad input [INPUT_INVALID] — status' }],
  })
  const recorded = (key: string) => ({ id: `cand-${key}`, workspace_id: WS, user_id: USER, dedupe_key: key, status: 'new', source: 'input_invalid' })

  it('chat: pages oldest first, recorded turns spend nothing, and the next pass takes what the budget left', async () => {
    const total = SCAN_PAGE_SIZE * 2 + 50
    // Oldest first: msg-000 is 80 minutes ago, each later one a few seconds newer.
    fake.seed(
      'chat_messages',
      Array.from({ length: total }, (_, i) => {
        const id = `msg-${String(i).padStart(3, '0')}`
        return msg({ id: `r-${id}`, role: 'assistant', ui_message: invalid(id), ui_message_id: id, created_at: new Date(NOW - 80 * 60_000 + i * 5_000).toISOString() })
      }),
    )
    // An earlier pass recorded the oldest page and a half.
    const already = SCAN_PAGE_SIZE + 100
    fake.seed('eval_candidate', Array.from({ length: already }, (_, i) => recorded(`chat:msg-${String(i).padStart(3, '0')}:INPUT_INVALID`)))

    const first = await sweepChatFailures(db(), NOW)
    expect(first).toMatchObject({ scanned: total, found: total, known: already, inserted: total - already, failed: 0 })
    expect(total - already).toBeLessThanOrEqual(RECORD_BUDGET)
    expect(fake.rows('eval_candidate')).toHaveLength(total)
    // The newest message, past the first read, was recorded.
    expect(fake.rows('eval_candidate').some((r) => r.dedupe_key === `chat:msg-${total - 1}:INPUT_INVALID`)).toBe(true)
  })

  it('chat: past RECORD_BUDGET the oldest go first and the next pass records the rest', async () => {
    const total = RECORD_BUDGET + 60
    fake.seed(
      'chat_messages',
      Array.from({ length: total }, (_, i) => {
        const id = `msg-${String(i).padStart(3, '0')}`
        return msg({ id: `r-${id}`, role: 'assistant', ui_message: invalid(id), ui_message_id: id, created_at: new Date(NOW - 50 * 60_000 + i * 5_000).toISOString() })
      }),
    )
    const first = await sweepChatFailures(db(), NOW)
    expect(first.inserted).toBe(RECORD_BUDGET)
    const keys = new Set(fake.rows('eval_candidate').map((r) => r.dedupe_key))
    expect(keys.has('chat:msg-000:INPUT_INVALID')).toBe(true)
    expect(keys.has(`chat:msg-${total - 1}:INPUT_INVALID`)).toBe(false)

    // The next pass, 30 minutes on: its window still holds them all.
    const second = await sweepChatFailures(db(), NOW + 30 * 60_000)
    expect(second).toMatchObject({ inserted: 60, known: RECORD_BUDGET })
    expect(fake.rows('eval_candidate')).toHaveLength(total)
  })

  it('loops: every failed job in the window is processed, past one read', async () => {
    fake.seed('member', [{ id: 'mem-1', user_id: USER }])
    const total = SCAN_PAGE_SIZE + 60
    fake.seed(
      'tracked_job',
      Array.from({ length: total }, (_, i) => ({
        id: `job-${String(i).padStart(3, '0')}`,
        workspace_id: WS,
        member_id: 'mem-1',
        kind: 'work_run',
        title: 'Draft',
        status: 'failed',
        error_message: 'model timed out',
        source: {},
        finished_at: new Date(NOW - 80 * 60_000 + i * 5_000).toISOString(),
      })),
    )
    fake.seed('eval_candidate', Array.from({ length: SCAN_PAGE_SIZE }, (_, i) => recorded(`job:job-${String(i).padStart(3, '0')}`)))
    const counts = await sweepFailedJobs(db(), NOW)
    expect(counts).toMatchObject({ scanned: total, found: total, known: SCAN_PAGE_SIZE, inserted: 60 })
    expect(fake.rows('eval_candidate')).toHaveLength(total)
  })
})

describe('purgeCandidates', () => {
  it('dismissed after 30 days, new after 90, promoted and exported kept', async () => {
    const day = 24 * 60 * 60_000
    const at = (days: number) => new Date(NOW - days * day).toISOString()
    fake.seed('eval_candidate', [
      { id: 'd-old', status: 'dismissed', reviewed_at: at(31), updated_at: at(31), created_at: at(40) },
      { id: 'd-new', status: 'dismissed', reviewed_at: at(5), updated_at: at(5), created_at: at(40) },
      { id: 'd-unstamped', status: 'dismissed', reviewed_at: null, updated_at: at(35), created_at: at(40) },
      { id: 'n-old', status: 'new', created_at: at(91), updated_at: at(91) },
      { id: 'n-fresh', status: 'new', created_at: at(10), updated_at: at(10) },
      { id: 'p-old', status: 'promoted', reviewed_at: at(200), created_at: at(200), updated_at: at(200) },
      { id: 'e-old', status: 'exported', reviewed_at: at(200), created_at: at(200), updated_at: at(200) },
    ])
    expect(await purgeCandidates(db(), NOW)).toEqual({ dismissed: 2, stale: 1 })
    expect(fake.rows('eval_candidate').map((r) => r.id).sort()).toEqual(['d-new', 'e-old', 'n-fresh', 'p-old'])
  })
})

describe('evalFlywheelSweep (the Inngest function)', () => {
  it('runs one step per stage and logs one counts-only line', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    try {
      fake.seed('chat_messages', [
        msg({ id: 'r1', role: 'user', ui_message: userMessage('Move ENG-1 to done, the secret plan'), ui_message_id: 'msg-u1', created_at: iso(31) }),
        msg({ id: 'r2', role: 'assistant', ui_message: assistantMessage('msg-a1'), ui_message_id: 'msg-a1', created_at: iso(30) }),
      ])
      const info = vi.spyOn(console, 'info').mockImplementation(() => {})
      await import('@/lib/inngest/eval-flywheel')
      const step = createStepMock()
      const out = (await hoisted.handler!({ step })) as { status: string; chat: { inserted: number } }
      expect(out.status).toBe('done')
      expect(out.chat.inserted).toBe(2)
      expect((step.run as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual(['chat-failures', 'failed-jobs', 'purge'])
      const lines = info.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[eval-flywheel]'))
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('chat scanned=')
      expect(lines[0]).not.toContain('secret')
      expect(lines[0]).not.toContain('ENG-1')
    } finally {
      vi.useRealTimers()
    }
  })
})

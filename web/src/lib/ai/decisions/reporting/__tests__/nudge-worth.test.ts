import { createClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { JEV_PROVEN_MIN_AGREEMENT, JEV_PROVEN_MIN_CASES } from '@/lib/agent-events/router'
import {
  NUDGE_THUMB_PROJECTION,
  NUDGE_WORTH_ANSWER_PROJECTION,
  NUDGE_WORTH_ROW_LIMIT,
  loadNudgeWorthReadout,
  provenFromThumbs,
  type NudgeThumbRow,
  type NudgeWorthAnswerRow,
} from '../nudge-worth'

const admin = vi.hoisted(() => ({ requireAdmin: vi.fn(), getAdminServiceClient: vi.fn() }))
vi.mock('@/lib/admin', () => admin)

const V1 = 'nudge-worth-v1'
const ans = (id: string, choice: string | null, outcome = 'accepted', version = V1): NudgeWorthAnswerRow =>
  ({ message_id: id, version, outcome, choice })
const up = (id: string): NudgeThumbRow => ({ ref_id: id, source: 'thumbs_up', nudge_reason: null })
const down = (id: string, reason: string | null = null): NudgeThumbRow => ({ ref_id: id, source: 'thumbs_down', nudge_reason: reason })

describe('provenFromThumbs (readout math, no enforcement)', () => {
  it('scores trusted answers on rated nudges: send ↔ 👍, hold ↔ 👎; a hold on a 👍 is a false suppression', () => {
    const [v] = provenFromThumbs(
      [ans('a', 'send'), ans('b', 'hold'), ans('c', 'hold'), ans('d', 'send'), ans('e', 'send')],
      [up('a'), down('b', 'repeated'), up('c'), down('d', 'not_useful')],
    )
    expect(v).toMatchObject({
      version: V1, answers: 5, send: 3, hold: 2, unsure: 0, failed: 0,
      thumbed: 4, thumbsUp: 2, thumbsDown: 2, tooLate: 0,
      scored: 4, agreed: 2, agreement: 0.5, falseSuppressions: 1, falseSends: 1, meetsBar: false,
    })
  })

  it('a 👎 marked too_late is a timing problem: counted apart, left out of agreement', () => {
    const [v] = provenFromThumbs([ans('a', 'send'), ans('b', 'hold'), ans('c', 'hold')], [down('a', 'too_late'), down('b', 'too_late'), down('c', 'wrong')])
    expect(v).toMatchObject({ thumbed: 3, thumbsDown: 3, tooLate: 2, scored: 1, agreed: 1, agreement: 1, falseSends: 0 })
  })

  it('a 👎 with no chip means hold was right (the plain thumbs-down rule)', () => {
    const [v] = provenFromThumbs([ans('a', 'hold'), ans('b', 'send')], [down('a'), down('b')])
    expect(v).toMatchObject({ scored: 2, agreed: 1, falseSends: 1, falseSuppressions: 0 })
  })

  it('unsure (untrusted) and failed answers are counted, never scored', () => {
    const [v] = provenFromThumbs(
      [ans('a', 'send', 'escalate'), ans('b', null, 'unavailable'), ans('c', null, 'deadline_exceeded'), ans('d', 'hold')],
      [up('a'), up('b'), up('d')],
    )
    expect(v).toMatchObject({ answers: 4, send: 0, hold: 1, unsure: 1, failed: 2, thumbed: 3, scored: 1, agreed: 0, falseSuppressions: 1 })
  })

  it('keeps versions apart, one answer per nudge (the newest row), and ignores other sources', () => {
    const out = provenFromThumbs(
      [ans('a', 'hold'), ans('a', 'send'), ans('a', 'hold', 'accepted', 'nudge-worth-v2'), ans('z', 'send')],
      [up('a'), { ref_id: 'z', source: 'repeated_failure', nudge_reason: null }],
    )
    expect(out.map((v) => v.version)).toEqual([V1, 'nudge-worth-v2'])
    expect(out[0]).toMatchObject({ answers: 2, send: 2, thumbed: 1, scored: 1, agreed: 1 })
    expect(out[1]).toMatchObject({ answers: 1, hold: 1, scored: 1, falseSuppressions: 1 })
  })

  it('compares to the router\'s proof bar (40 at 90%), unchanged and informational', () => {
    expect(JEV_PROVEN_MIN_CASES).toBe(40)
    expect(JEV_PROVEN_MIN_AGREEMENT).toBe(0.9)
    const ids = Array.from({ length: 40 }, (_, i) => `n${i}`)
    const answers = ids.map((id, i) => ans(id, i < 36 ? 'send' : 'hold'))
    expect(provenFromThumbs(answers, ids.map(up))[0]).toMatchObject({ scored: 40, agreed: 36, agreement: 0.9, meetsBar: true })
    expect(provenFromThumbs(answers.slice(1), ids.slice(1).map(up))[0]).toMatchObject({ scored: 39, meetsBar: false })
    expect(provenFromThumbs([], [])).toEqual([])
  })
})

describe('loadNudgeWorthReadout (bounded admin reads)', () => {
  let requests: URL[]
  let serve: (url: URL) => Response
  const json = (rows: unknown[]) => new Response(JSON.stringify(rows), { status: 200, headers: { 'Content-Type': 'application/json' } })
  beforeEach(() => {
    requests = []
    serve = () => json([])
    admin.requireAdmin.mockReset().mockResolvedValue({ id: 'admin' })
    admin.getAdminServiceClient.mockReset().mockResolvedValue(createClient('https://nudge-test.invalid', 'k', {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: async (input) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
        requests.push(url)
        return serve(url)
      } },
    }))
  })

  it('requires admin before any read', async () => {
    const denied = new Response('no', { status: 401 })
    admin.requireAdmin.mockRejectedValue(denied)
    await expect(loadNudgeWorthReadout()).rejects.toBe(denied)
    expect(requests).toHaveLength(0)
  })

  it('reads the last 30 days of answers and nudge thumbs with narrow projections, then joins them', async () => {
    const now = Date.parse('2026-10-18T12:00:00Z')
    serve = (url) => url.pathname.endsWith('/ai_usage_logs')
      ? json([{ message_id: 'm1', version: V1, outcome: 'accepted', choice: 'hold' }])
      : json([{ ref_id: 'm1', source: 'thumbs_up', nudge_reason: null }])
    const out = await loadNudgeWorthReadout({ now, workspaceId: 'AA5DC58B-C0CF-4332-BBDC-AC622826D388' })
    const usage = requests.find((u) => u.pathname.endsWith('/ai_usage_logs'))!
    expect(usage.searchParams.get('select')).toBe(NUDGE_WORTH_ANSWER_PROJECTION)
    expect(usage.searchParams.get('feature')).toBe('eq.decision.nudge.worth')
    expect(usage.searchParams.getAll('created_at')).toEqual(['gte.2026-09-18T12:00:00.000Z', 'lt.2026-10-18T12:00:00.000Z'])
    expect(usage.searchParams.get('metadata->>workspace_id')).toBe('eq.aa5dc58b-c0cf-4332-bbdc-ac622826d388')
    const thumbs = requests.find((u) => u.pathname.endsWith('/eval_candidate'))!
    expect(thumbs.searchParams.get('select')).toBe(NUDGE_THUMB_PROJECTION)
    expect(thumbs.searchParams.get('ref_type')).toBe('eq.chat_message')
    expect(thumbs.searchParams.get('source')).toBe('in.(thumbs_up,thumbs_down)')
    expect(thumbs.searchParams.get('evidence->>nudge_kind')).toBe('not.is.null')
    expect(out).toMatchObject({ windowDays: 30, partial: false, bar: { minCases: 40, minAgreement: 0.9 } })
    expect(out.versions[0]).toMatchObject({ scored: 1, falseSuppressions: 1 })
  })

  it('stops at its row bound and says the counts are partial', async () => {
    const page = Array.from({ length: 1000 }, (_, i) => ({ message_id: `m${i}`, version: V1, outcome: 'accepted', choice: 'send' }))
    serve = (url) => url.pathname.endsWith('/ai_usage_logs') ? json(page) : json([])
    const out = await loadNudgeWorthReadout()
    expect(requests.filter((u) => u.pathname.endsWith('/ai_usage_logs'))).toHaveLength(NUDGE_WORTH_ROW_LIMIT / 1000)
    expect(out.partial).toBe(true)
  })

  it('a failed read is partial, never a thrown page', async () => {
    serve = (url) => url.pathname.endsWith('/eval_candidate') ? new Response('{"message":"boom"}', { status: 500 }) : json([])
    const out = await loadNudgeWorthReadout()
    expect(out.partial).toBe(true)
    expect(out.versions).toEqual([])
  })
})

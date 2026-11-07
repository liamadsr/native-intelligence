/**
 * The one candidate writer (record.ts). Pinned:
 *   - insert, then update in place on the same (workspace, user, key), or
 *     leave it with onExisting 'skip';
 *   - a reviewed row is never overwritten ('locked'), including a promote
 *     that lands between the read and the fenced update;
 *   - a duplicate-key race applies the rules to the winner's row;
 *   - polarity comes from the source; every text is clipped; evidence over
 *     the byte budget is trimmed (steps, then texts), never refused;
 *   - a draft rewrite keeps a score and pointers only, whatever it was given;
 *   - it never throws: a failed read or write answers 'failed'.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { clipEvidence, clipEvidenceFields, clipList, clipTail, clipText, recordEvalCandidate, type RecordEvalCandidateInput } from '../record'
import { jsonbTextBytes } from '../bytes'
import { FLYWHEEL_LIMITS, type ChatTurnEvidence, type DraftDismissedEvidence, type DraftRewriteEvidence, type LoopRunEvidence } from '../types'

const WS = 'a1000000-0000-4000-8000-000000000001'
const USER = 'b1000000-0000-4000-8000-000000000001'

let fake: FakeSupabase
const db = () => fake as unknown as SupabaseClient

const turn = (over: Partial<ChatTurnEvidence> = {}): ChatTurnEvidence => ({
  kind: 'chat_turn',
  request: 'Move ENG-1 to done',
  reply: 'I could not update ENG-1.',
  steps: [{ name: 'update_action', input: '{"id":"ENG-1"}', ok: false, code: 'REPEATED_FAILURE', error: 'This exact call failed 3 times.' }],
  loads: ['triage'],
  messageId: 'msg-1',
  ...over,
})

const input = (over: Partial<RecordEvalCandidateInput> = {}): RecordEvalCandidateInput => ({
  workspaceId: WS,
  userId: USER,
  source: 'thumbs_down',
  dedupeKey: 'feedback:msg-1',
  evidence: turn(),
  refType: 'chat_message',
  refId: 'msg-1',
  conversationId: 'c1000000-0000-4000-8000-000000000001',
  skillSlugs: ['triage'],
  tools: ['update_action'],
  ...over,
})

beforeEach(() => {
  fake = makeFakeSupabase({ unique: { eval_candidate: ['dedupe_key'] } })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('recordEvalCandidate: one row per signal', () => {
  it('inserts a new row with polarity from the source and status new', async () => {
    expect(await recordEvalCandidate(db(), input({ reason: 'Wrong action' }))).toBe('inserted')
    const [row] = fake.rows('eval_candidate')
    expect(row).toMatchObject({
      workspace_id: WS,
      user_id: USER,
      dedupe_key: 'feedback:msg-1',
      source: 'thumbs_down',
      polarity: 'bad',
      status: 'new',
      reason: 'Wrong action',
      ref_type: 'chat_message',
      ref_id: 'msg-1',
      skill_slugs: ['triage'],
      tools: ['update_action'],
    })
    expect((row.evidence as ChatTurnEvidence).steps[0].code).toBe('REPEATED_FAILURE')
  })

  it('a thumbs-up is the good polarity', async () => {
    await recordEvalCandidate(db(), input({ source: 'thumbs_up' }))
    expect(fake.rows('eval_candidate')[0].polarity).toBe('good')
  })

  it('a second record updates in place: the rating changes, the reason is kept unless given', async () => {
    await recordEvalCandidate(db(), input({ reason: 'Wrong action' }))
    expect(await recordEvalCandidate(db(), input({ source: 'thumbs_up' }))).toBe('updated')
    let rows = fake.rows('eval_candidate')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ source: 'thumbs_up', polarity: 'good', reason: 'Wrong action' })
    expect(typeof rows[0].updated_at).toBe('string')
    expect(await recordEvalCandidate(db(), input({ reason: null }))).toBe('updated')
    rows = fake.rows('eval_candidate')
    expect(rows[0]).toMatchObject({ source: 'thumbs_down', reason: null })
  })

  it("onExisting 'skip' leaves a new row as it is", async () => {
    await recordEvalCandidate(db(), input({ source: 'repeated_failure', dedupeKey: 'chat:msg-1:REPEATED_FAILURE' }))
    const out = await recordEvalCandidate(db(), input({ source: 'repeated_failure', dedupeKey: 'chat:msg-1:REPEATED_FAILURE', evidence: turn({ request: 'changed' }), onExisting: 'skip' }))
    expect(out).toBe('skipped')
    expect((fake.rows('eval_candidate')[0].evidence as ChatTurnEvidence).request).toBe('Move ENG-1 to done')
  })

  it('the same key in another workspace or for another person is its own row', async () => {
    await recordEvalCandidate(db(), input())
    const other = makeFakeSupabase()
    other.seed('eval_candidate', [...fake.rows('eval_candidate')])
    expect(await recordEvalCandidate(other as unknown as SupabaseClient, input({ userId: 'b1000000-0000-4000-8000-000000000002' }))).toBe('inserted')
    expect(other.rows('eval_candidate')).toHaveLength(2)
  })
})

describe('recordEvalCandidate: a reviewed row is never overwritten', () => {
  for (const status of ['promoted', 'exported', 'dismissed']) {
    it(`a ${status} row answers locked and is left alone`, async () => {
      fake.seed('eval_candidate', [{ id: 'row-1', workspace_id: WS, user_id: USER, dedupe_key: 'feedback:msg-1', status, source: 'thumbs_down', reason: 'kept' }])
      expect(await recordEvalCandidate(db(), input({ source: 'thumbs_up', reason: 'new' }))).toBe('locked')
      expect(fake.rows('eval_candidate')[0]).toMatchObject({ status, source: 'thumbs_down', reason: 'kept' })
    })
  }

  it('a promote between the read and the update wins (the update is fenced on new)', async () => {
    fake.seed('eval_candidate', [{ id: 'row-1', workspace_id: WS, user_id: USER, dedupe_key: 'feedback:msg-1', status: 'new', source: 'thumbs_down' }])
    const raced = {
      from(table: string) {
        const b = fake.from(table) as Record<string, (...a: unknown[]) => unknown>
        const update = b.update
        b.update = (patch: unknown) => {
          // A reviewer promotes the row just before our write lands.
          fake.rows('eval_candidate')[0].status = 'promoted'
          return update(patch)
        }
        return b
      },
    }
    expect(await recordEvalCandidate(raced as unknown as SupabaseClient, input({ source: 'thumbs_up' }))).toBe('locked')
    expect(fake.rows('eval_candidate')[0]).toMatchObject({ status: 'promoted', source: 'thumbs_down' })
  })

  it('a duplicate-key race applies the rules to the row that won', async () => {
    const real = fake
    let inserted = false
    const racing = {
      from(table: string) {
        const b = real.from(table) as Record<string, (...a: unknown[]) => unknown>
        const insert = b.insert
        b.insert = (row: unknown) => {
          if (!inserted) {
            inserted = true
            // Another writer lands the same key first.
            real.seed('eval_candidate', [{ id: 'winner', workspace_id: WS, user_id: USER, dedupe_key: 'feedback:msg-1', status: 'new', source: 'thumbs_down' }])
          }
          return insert(row)
        }
        return b
      },
    }
    expect(await recordEvalCandidate(racing as unknown as SupabaseClient, input({ source: 'thumbs_up' }))).toBe('updated')
    expect(real.rows('eval_candidate')).toHaveLength(1)
    expect(real.rows('eval_candidate')[0]).toMatchObject({ id: 'winner', source: 'thumbs_up' })
  })
})

describe('recordEvalCandidate: never throws', () => {
  it('a failed insert answers failed', async () => {
    fake.failNextInsert('eval_candidate', { code: '23514', message: 'check violated' })
    expect(await recordEvalCandidate(db(), input())).toBe('failed')
  })

  it('a client that throws answers failed', async () => {
    const broken = { from: () => { throw new Error('boom') } }
    expect(await recordEvalCandidate(broken as unknown as SupabaseClient, input())).toBe('failed')
  })

  it('missing identity answers failed without a write', async () => {
    expect(await recordEvalCandidate(db(), input({ userId: '' }))).toBe('failed')
    expect(await recordEvalCandidate(db(), input({ dedupeKey: '   ' }))).toBe('failed')
    expect(fake.rows('eval_candidate')).toHaveLength(0)
  })
})

describe('clipping', () => {
  it('clipText trims and cuts with an ellipsis; clipTail keeps the end', () => {
    expect(clipText('  hello  ', 10)).toBe('hello')
    expect(clipText('abcdefghij', 5)).toBe('abcd…')
    expect(clipText(42, 5)).toBe('')
    expect(clipTail('abcdefghij', 5)).toBe('…ghij')
  })

  it('never splits a surrogate pair (an emoji at the cut), however the text is clipped', () => {
    const lone = (s: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s)
    // clipText keeps max - 1 units plus the ellipsis: 'abc' + the emoji's high half at max 5.
    expect(clipText('abc😀defgh', 5)).toBe('abc…')
    expect(clipTail('abcdefg😀hi', 4)).toBe('…hi')
    const text = '😀'.repeat(3000)
    for (const max of [1, 2, 3, 600, 1499, 1500, 2000]) {
      expect(lone(clipText(text, max))).toBe(false)
      expect(lone(clipTail(text, max))).toBe(false)
    }
    // The byte trim halves texts: every halving lands on a pair boundary too.
    const out = clipEvidence(turn({ request: 'x' + '😀'.repeat(999), reply: 'y' + '😀'.repeat(749) }), 900) as ChatTurnEvidence
    expect(lone(out.request)).toBe(false)
    expect(lone(out.reply ?? '')).toBe(false)
    const loop = clipEvidence({ kind: 'loop_run', jobKind: 'flow_run', error: 'e' + '😀'.repeat(299), logTail: 'l' + '😀'.repeat(749) }, 500) as LoopRunEvidence
    expect(lone(loop.error ?? '')).toBe(false)
    expect(lone(loop.logTail ?? '')).toBe(false)
  })

  it('clipList keeps non-empty strings, once each, up to the cap', () => {
    expect(clipList(['a', '', 'b', 'a', 3, 'c'], 2)).toEqual(['a', 'b'])
  })

  it('every field is cut to FLYWHEEL_LIMITS on write, and the lists to the table caps', async () => {
    const long = 'x'.repeat(5000)
    await recordEvalCandidate(
      db(),
      input({
        reason: long,
        refId: long,
        evidence: turn({ request: long, reply: long, steps: Array.from({ length: 50 }, (_, i) => ({ name: `t${i}`, input: long, ok: false, error: long })) }),
        skillSlugs: Array.from({ length: 30 }, (_, i) => `s${i}`),
        tools: Array.from({ length: 60 }, (_, i) => `t${i}`),
      }),
    )
    const row = fake.rows('eval_candidate')[0]
    expect((row.reason as string).length).toBe(FLYWHEEL_LIMITS.reason)
    expect((row.ref_id as string).length).toBeLessThanOrEqual(300)
    expect(row.skill_slugs as string[]).toHaveLength(FLYWHEEL_LIMITS.skillSlugs)
    expect(row.tools as string[]).toHaveLength(FLYWHEEL_LIMITS.tools)
    const ev = row.evidence as ChatTurnEvidence
    expect(ev.request.length).toBeLessThanOrEqual(FLYWHEEL_LIMITS.request)
    expect(jsonbTextBytes(ev)).toBeLessThanOrEqual(FLYWHEEL_LIMITS.evidenceBytes)
    expect(ev.steps.length).toBeLessThanOrEqual(FLYWHEEL_LIMITS.steps)
    for (const s of ev.steps) {
      expect((s.input ?? '').length).toBeLessThanOrEqual(FLYWHEEL_LIMITS.stepInput)
      expect((s.error ?? '').length).toBeLessThanOrEqual(FLYWHEEL_LIMITS.stepError)
    }
  })

  it('over the byte budget: later successful steps go first, the failures stay', () => {
    const steps = [
      { name: 'list_actions', input: 'i'.repeat(600), ok: true },
      { name: 'update_action', input: 'i'.repeat(600), ok: false, code: 'INPUT_INVALID', error: 'e'.repeat(300) },
      ...Array.from({ length: 28 }, (_, i) => ({ name: `ok_${i}`, input: 'i'.repeat(600), ok: true })),
    ]
    const out = clipEvidence(turn({ steps }), 4000) as ChatTurnEvidence
    expect(jsonbTextBytes(out)).toBeLessThanOrEqual(4000)
    expect(out.steps.find((s) => s.code === 'INPUT_INVALID')).toBeTruthy()
  })

  it('a tiny budget still yields evidence (texts halved, inputs dropped), never an error', () => {
    const out = clipEvidence(turn({ request: 'r'.repeat(2000), reply: 'p'.repeat(1500) }), 600) as ChatTurnEvidence
    expect(out.kind).toBe('chat_turn')
    expect(jsonbTextBytes(out)).toBeLessThanOrEqual(600)
  })

  it('a loop run trims its log tail first', () => {
    const ev: LoopRunEvidence = { kind: 'loop_run', jobKind: 'flow_run', error: 'model timed out', logTail: 'l'.repeat(1500), flowErrors: [{ action: 'run_skill', error: 'x'.repeat(300) }] }
    const out = clipEvidence(ev, 900) as LoopRunEvidence
    expect(jsonbTextBytes(out)).toBeLessThanOrEqual(900)
    expect(out.error).toBe('model timed out')
  })

  it('a draft rewrite keeps a score and pointers only, whatever it was handed', () => {
    const smuggled = { kind: 'draft_rewrite', similarity: 1.7, wordsBefore: 40.4, wordsAfter: -3, origin: 'nope', providerThreadId: 'thr-1', body: 'secret mail text', subject: 'secret' } as unknown as DraftRewriteEvidence
    const out = clipEvidence(smuggled)
    expect(out).toEqual({ kind: 'draft_rewrite', similarity: 1, wordsBefore: 40, wordsAfter: 0, origin: 'unknown', providerThreadId: 'thr-1' })
  })

  it('jsonbTextBytes measures as Postgres prints jsonb (spaces after : and ,)', () => {
    expect(jsonbTextBytes({ a: 1, b: [1, 2] })).toBe('{"a": 1, "b": [1, 2]}'.length)
    expect(jsonbTextBytes({ s: 'é' })).toBe(new TextEncoder().encode('{"s": "é"}').length)
  })
})

describe('a dismissed draft keeps its reason and pointers only (GEN-1165)', () => {
  it('drops smuggled text, an address in the domain field, and an unknown reason', () => {
    const smuggled = {
      kind: 'draft_dismissed',
      reason: 'junk',
      origin: 'explicit',
      by: 'someone',
      recipientDomain: 'messenger@Reply2.SquareUp.com',
      providerThreadId: 'thr-1',
      accountId: 'acct-1',
      subject: 'secret',
      body: 'secret mail text',
    } as unknown as DraftDismissedEvidence
    expect(clipEvidence(smuggled)).toEqual({ kind: 'draft_dismissed', reason: 'other', origin: 'unknown', by: 'agent', providerThreadId: 'thr-1', accountId: 'acct-1' })
  })

  it('keeps a plain domain, lowercased', () => {
    const ok = { kind: 'draft_dismissed', reason: 'no_reply_needed', origin: 'automatic', by: 'person', recipientDomain: 'Reply2.SquareUp.com' } as DraftDismissedEvidence
    expect(clipEvidence(ok)).toEqual({ ...ok, recipientDomain: 'reply2.squareup.com' })
  })
})

describe('a nudge’s pointers survive the explicit field list', () => {
  const nudge = { kind: 'chat_turn', request: '', steps: [], loads: [], messageId: 'n1', nudge_kind: 'reminder', capture_id: 'cap-1', nudge_at: '2026-10-16T10:01:00.000Z', meeting_goal_id: 'goal-1' }

  it('keeps nudge_kind, capture_id, nudge_at, meeting_goal_id and a known nudge_reason', () => {
    expect(clipEvidenceFields({ ...nudge, nudge_reason: 'too_late' } as ChatTurnEvidence)).toMatchObject({ ...nudge, nudge_reason: 'too_late' })
  })

  it('drops an unknown nudge_reason and any field it does not list', () => {
    const out = clipEvidenceFields({ ...nudge, nudge_reason: 'boring', transcript: 'Dana: forty thousand' } as unknown as ChatTurnEvidence)
    expect(out).not.toHaveProperty('nudge_reason')
    expect(out).not.toHaveProperty('transcript')
  })
})

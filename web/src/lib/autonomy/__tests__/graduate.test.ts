/**
 * graduationFor (docs/plans/earned-autonomy.md §5, phase 3): a granted kind's
 * held call runs on its own only when every check passes, and each check that
 * fails sends it back to the person's card. Liam, 11-27, decisions 1 to 4.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { graduationFor, UNDO_WINDOW_MINUTES, type GraduationArgs } from '../graduate'
import { kindOfCall } from '../kind'
import { MAX_AUTONOMOUS_PER_KIND_PER_DAY, MAX_AUTONOMOUS_PER_PERSON_PER_DAY } from '../rules'

const WS = 'ws-1'
const USER = 'user-1'
const NOW = new Date('2026-11-27T12:00:00Z')
const DAY = 86_400_000
const env = { EARNED_AUTONOMY: 'graduate' }
const call = { tool: 'create_calendar_event', input: { title: 'Sync', attendees: ['dana@example.com'] } }
const KEY = kindOfCall(call).key
const args = (over: Partial<GraduationArgs> = {}): GraduationArgs => ({ workspaceId: WS, userId: USER, ...call, caller: 'person', decision: 'ask', now: NOW, ...over })
const knowAll = vi.fn(async (_db: unknown, a: { recipients: readonly string[] }) => new Set(a.recipients))
const deps = { env, paused: async () => false, known: knowAll as never }
let db: FakeSupabase

function grant(level: 'tell' | 'quiet' = 'tell', extra: Record<string, unknown> = {}) {
  db.seed('autonomy_kind', [{ id: 'k1', workspace_id: WS, user_id: USER, kind_key: KEY, level, pinned_ask: false, granted_at: new Date(NOW.getTime() - 20 * DAY).toISOString(), demoted_at: null, offer_declined_at: null, ...extra }])
}

beforeEach(() => {
  db = makeFakeSupabase({ bulkUpsert: true })
  knowAll.mockClear()
})

describe('graduationFor', () => {
  it('a granted kind, every check passing: runs at the end of a 5-minute window, at tell', async () => {
    grant()
    const g = await graduationFor(db as never, args(), deps)
    expect(g).toMatchObject({ run: true, level: 'tell', kind: { key: KEY } })
    if (g.run) expect(Date.parse(g.runAt) - NOW.getTime()).toBe(UNDO_WINDOW_MINUTES * 60_000)
    expect(UNDO_WINDOW_MINUTES).toBe(5)
  })

  it('off unless EARNED_AUTONOMY=graduate; under record it never runs; nothing is read', async () => {
    grant()
    for (const e of [{}, { EARNED_AUTONOMY: '' }, { EARNED_AUTONOMY: 'record' }]) {
      expect(await graduationFor(db as never, args(), { ...deps, env: e })).toEqual({ run: false, reason: 'off' })
    }
    expect(db.calls).toHaveLength(0)
  })

  it('never widens who may raise a call: a denied hold stays denied, and only the person or an asking unattended door', async () => {
    grant()
    expect(await graduationFor(db as never, args({ decision: 'deny', caller: 'agent_unattended' }), deps)).toMatchObject({ run: false, reason: 'caller' })
    for (const caller of ['guest', 'other_person', 'unknown']) expect(await graduationFor(db as never, args({ caller }), deps)).toMatchObject({ run: false, reason: 'caller' })
    expect(await graduationFor(db as never, args({ caller: 'agent_unattended' }), deps)).toMatchObject({ run: true })
  })

  it("a guest's call and a Mac job's call always ask", async () => {
    grant()
    expect(await graduationFor(db as never, args({ context: { guest: { id: 'g' } } }), deps)).toMatchObject({ run: false, reason: 'guest' })
    expect(await graduationFor(db as never, args({ localAgent: { jobId: 'j' } }), deps)).toMatchObject({ run: false, reason: 'mac_job' })
  })

  it('a hard-limited kind never runs, even with a stored grant', async () => {
    const pay = { tool: 'send_payment_link', input: { to: 'dana@example.com' } }
    db.seed('autonomy_kind', [{ workspace_id: WS, user_id: USER, kind_key: kindOfCall(pay).key, level: 'tell', pinned_ask: false, granted_at: NOW.toISOString() }])
    expect(await graduationFor(db as never, args(pay), deps)).toMatchObject({ run: false, reason: 'hard_limit' })
    const many = { tool: 'create_calendar_event', input: { attendees: ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com'] } }
    expect(await graduationFor(db as never, args(many), deps)).toMatchObject({ run: false, reason: 'hard_limit' })
  })

  it('the kill switch stops it', async () => {
    grant()
    expect(await graduationFor(db as never, args(), { ...deps, paused: async () => true })).toMatchObject({ run: false, reason: 'paused' })
  })

  it('no grant, a revoked grant (ask), or "Never": the card', async () => {
    expect(await graduationFor(db as never, args(), deps)).toMatchObject({ run: false, reason: 'not_granted' })
    db = makeFakeSupabase({ bulkUpsert: true })
    grant('tell', { level: 'ask' })
    expect(await graduationFor(db as never, args(), deps)).toMatchObject({ run: false, reason: 'not_granted' })
    db = makeFakeSupabase({ bulkUpsert: true })
    grant('tell', { pinned_ask: true })
    expect(await graduationFor(db as never, args(), deps)).toMatchObject({ run: false, reason: 'not_granted' })
  })

  it('one undo after the grant demotes it: the card (decision 4)', async () => {
    grant()
    db.seed('autonomy_outcome', [{ workspace_id: WS, user_id: USER, kind_key: KEY, outcome: 'undone', edit_ratio: null, created_at: new Date(NOW.getTime() - DAY).toISOString() }])
    expect(await graduationFor(db as never, args(), deps)).toMatchObject({ run: false, reason: 'demoted' })
  })

  it('a stored quiet runs at tell while quiet is off (decision 2)', async () => {
    grant('quiet')
    expect(await graduationFor(db as never, args(), deps)).toMatchObject({ run: true, level: 'tell' })
    expect(await graduationFor(db as never, args(), { ...deps, env: { EARNED_AUTONOMY: 'graduate', EARNED_AUTONOMY_QUIET: '1' } })).toMatchObject({ run: true, level: 'quiet' })
  })

  it('20 of a kind today: the 21st is a card; a cancelled one does not count', async () => {
    grant()
    const at = new Date(NOW.getTime() - 3_600_000).toISOString()
    db.seed('autonomy_action', Array.from({ length: MAX_AUTONOMOUS_PER_KIND_PER_DAY }, (_, i) => ({ id: `a${i}`, workspace_id: WS, user_id: USER, kind_key: KEY, status: i === 0 ? 'cancelled' : 'ran', created_at: at })))
    expect(await graduationFor(db as never, args(), deps)).toMatchObject({ run: true })
    db.seed('autonomy_action', [{ id: 'extra', workspace_id: WS, user_id: USER, kind_key: KEY, status: 'ran', created_at: at }])
    expect(await graduationFor(db as never, args(), deps)).toMatchObject({ run: false, reason: 'kind_cap' })
    expect(MAX_AUTONOMOUS_PER_KIND_PER_DAY).toBe(20)
  })

  it('50 across kinds today: the 51st is a card', async () => {
    grant()
    const at = new Date(NOW.getTime() - 3_600_000).toISOString()
    db.seed('autonomy_action', Array.from({ length: MAX_AUTONOMOUS_PER_PERSON_PER_DAY }, (_, i) => ({ id: `a${i}`, workspace_id: WS, user_id: USER, kind_key: `other_${i % 5}|calendar|one`, status: 'ran', created_at: at })))
    expect(await graduationFor(db as never, args(), deps)).toMatchObject({ run: false, reason: 'person_cap' })
    expect(MAX_AUTONOMOUS_PER_PERSON_PER_DAY).toBe(50)
  })

  it('the runner\'s re-check does not count its own row against the caps', async () => {
    grant()
    const at = new Date(NOW.getTime() - 3_600_000).toISOString()
    db.seed('autonomy_action', Array.from({ length: MAX_AUTONOMOUS_PER_KIND_PER_DAY }, (_, i) => ({ id: `a${i}`, workspace_id: WS, user_id: USER, kind_key: KEY, status: i === 0 ? 'scheduled' : 'ran', created_at: at })))
    expect(await graduationFor(db as never, args(), deps)).toMatchObject({ run: false, reason: 'kind_cap' })
    expect(await graduationFor(db as never, args({ recheckActionId: 'a0' }), deps)).toMatchObject({ run: true })
  })

  it('never to someone new, checked on every call', async () => {
    grant()
    expect(await graduationFor(db as never, args(), { ...deps, known: (async () => new Set()) as never })).toMatchObject({ run: false, reason: 'new_recipient' })
  })

  it('a read that fails is a no (the card)', async () => {
    grant()
    const broken = { from: () => { throw new Error('down') } }
    expect(await graduationFor(broken as never, args(), deps)).toMatchObject({ run: false, reason: 'read_failed' })
  })
})

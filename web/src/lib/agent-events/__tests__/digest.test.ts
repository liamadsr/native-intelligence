/**
 * The daily digest (A6 slice 4, src/lib/agent-events/digest.ts; the turn
 * itself goes through A4's home-turn consumer).
 *
 * Pinned:
 *   • selection by LOCAL hour: 8:00 in the stored zone, across a DST change
 *     (London picked at 07:00Z in summer time and 08:00Z in winter), a
 *     half-hour zone; no zone or a bad one falls back (another workspace's
 *     zone, the legacy profile zone, then UTC) and is still scheduled;
 *   • the skips: no home thread, today's turn already there (a failed one may
 *     go again), autonomy off, a dormant workspace, nothing to say;
 *   • the request: one per conversation and local date (Inngest event id),
 *     reason 'digest' with the event ids;
 *   • the gather: undelivered quiet/notify rows (not expired), restricted to
 *     the ids the cron named, plus log lines since the last digest that no row
 *     stands for; the body: counts then lines, waiting on you first;
 *   • delivery: only undelivered rows are marked, with the day's key and the
 *     home turn;
 *   • the face notice: ONE `agent_digest` from the Assistant per person per
 *     day, its words Native Intelligence's own;
 *   • the plan step of the home turn: a digest re-reads the rows, keys the turn
 *     `digest:<date>`, and skips with nothing new.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const notify = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>>, db: null as null | (() => FakeSupabase) }))
vi.mock('@/lib/notifications', () => ({
  createNotification: vi.fn(async (p: Record<string, unknown>) => {
    const row = { id: `n-${notify.rows.length + 1}`, recipient_id: p.recipientId, type: p.type, group_key: p.groupKey, title: p.title, body: p.body, metadata: p.metadata, created_at: new Date().toISOString() }
    notify.rows.push(row)
    notify.db?.().seed('notification', [row])
  }),
}))
vi.mock('@/lib/work/system-teammates', () => ({ systemTeammateId: vi.fn(async () => 'assistant-1') }))

import {
  DIGEST_LOCAL_HOUR,
  digestBody,
  digestNoticeCopy,
  digestRequest,
  findDigestCandidates,
  gatherDigest,
  localClock,
  markDigestDelivered,
  planDigestFor,
  sendDigestNotice,
  type DigestCandidate,
} from '../digest'
import { planHomeTurn } from '@/lib/chat/home-turn-server'
import { pickTimeZone, resolveMemberTimeZone } from '../member-time-zone'

const WS = '33333333-3333-4333-8333-333333333333'
const USER = '22222222-2222-4222-8222-222222222222'
const CONV = '11111111-1111-4111-8111-111111111111'

// 2026-10-14 is British Summer Time (UTC+1); 2026-11-02 is GMT (DST ended 2026-10-25).
const SUMMER_7Z = Date.parse('2026-10-14T07:00:00.000Z')
const WINTER_8Z = Date.parse('2026-11-02T08:00:00.000Z')

let db: FakeSupabase
let seq = 0
const ago = (now: number, min: number) => new Date(now - min * 60_000).toISOString()
const event = (over: Record<string, unknown>) => ({
  id: String(++seq),
  workspace_id: WS,
  user_id: USER,
  kind: 'email.drafted',
  state: 'routed',
  outcome: 'quiet',
  facts: { title: 'Re: pricing' },
  occurs_at: ago(SUMMER_7Z, 60),
  expires_at: null,
  ref_type: null,
  ref_id: null,
  delivered_at: null,
  delivered_key: null,
  ...over,
})

/** Replace a table's rows (the fake's seed appends). */
const reset = (table: string, rows: Array<Record<string, unknown>>) => void db.rows(table).splice(0, Infinity, ...rows)

const cand = (over: Partial<DigestCandidate> = {}): DigestCandidate => ({
  memberId: 'm1',
  userId: USER,
  workspaceId: WS,
  timeZone: 'Europe/London',
  date: '2026-10-14',
  ...over,
})
const open = { pausedState: async () => 'active' as const, isDormant: async () => false }

beforeEach(() => {
  db = makeFakeSupabase()
  seq = 0
  notify.rows = []
  notify.db = () => db
  db.seed('chat_conversations', [{ id: CONV, user_id: USER, workspace_id: WS, is_home: true, eve_session_id: 'sess-home' }])
  db.seed('member', [{ id: 'm1', user_id: USER, workspace_id: WS, time_zone: 'Europe/London' }])
  db.seed('workspace', [{ id: WS, settings: {} }])
})

describe('localClock', () => {
  it('reads the local hour and date in the zone, DST included', () => {
    expect(localClock('Europe/London', SUMMER_7Z)).toEqual({ hour: 8, date: '2026-10-14' })
    expect(localClock('Europe/London', WINTER_8Z)).toEqual({ hour: 8, date: '2026-11-02' })
    expect(localClock('Europe/London', WINTER_8Z - 60 * 60_000)).toEqual({ hour: 7, date: '2026-11-02' })
    expect(localClock('America/New_York', Date.parse('2026-10-14T12:00:00.000Z'))).toEqual({ hour: 8, date: '2026-10-14' })
    expect(localClock('America/New_York', Date.parse('2026-11-02T13:00:00.000Z'))).toEqual({ hour: 8, date: '2026-11-02' })
    // A half-hour zone: 8 o'clock from 02:30Z.
    expect(localClock('Asia/Kolkata', Date.parse('2026-10-14T03:00:00.000Z'))).toEqual({ hour: 8, date: '2026-10-14' })
    // The local date, not UTC's.
    expect(localClock('Pacific/Auckland', Date.parse('2026-10-13T19:00:00.000Z'))).toEqual({ hour: 8, date: '2026-10-14' })
    expect(localClock('Not/AZone', SUMMER_7Z)).toBeNull()
  })
})

describe('findDigestCandidates', () => {
  beforeEach(() => {
    reset('member', [
      { id: 'm1', user_id: 'u-lon', workspace_id: WS, time_zone: 'Europe/London' },
      { id: 'm2', user_id: 'u-ny', workspace_id: WS, time_zone: 'America/New_York' },
      { id: 'm3', user_id: 'u-none', workspace_id: WS, time_zone: null },
      { id: 'm4', user_id: 'u-bad', workspace_id: WS, time_zone: 'Mars/Olympus' },
      { id: 'm5', user_id: 'u-lon2', workspace_id: 'w2', time_zone: 'Europe/London' },
    ])
  })

  it('picks everyone whose local hour is 8, with their local date', async () => {
    const got = await findDigestCandidates(db as never, SUMMER_7Z)
    expect(got.map((c) => c.userId).sort()).toEqual(['u-lon', 'u-lon2'])
    expect(got[0]).toMatchObject({ timeZone: 'Europe/London', timeZoneSource: 'member', date: '2026-10-14' })
    expect(DIGEST_LOCAL_HOUR).toBe(8)
  })

  it('follows DST: after the clocks change, the same people are picked an hour later in UTC', async () => {
    expect(await findDigestCandidates(db as never, WINTER_8Z - 60 * 60_000)).toEqual([])
    // At 08:00Z in winter London reads 8, and so does UTC: the no-zone and
    // bad-zone members fall back to UTC and are scheduled too.
    expect((await findDigestCandidates(db as never, WINTER_8Z)).map((c) => c.userId).sort()).toEqual([
      'u-bad',
      'u-lon',
      'u-lon2',
      'u-none',
    ])
    expect((await findDigestCandidates(db as never, Date.parse('2026-11-02T13:00:00.000Z'))).map((c) => c.userId)).toEqual(['u-ny'])
  })

  describe('a member with no stored zone (2026-10 PROD audit: their rows never reached a digest)', () => {
    // 2026-10-14 08:00Z: UTC reads 8; London (BST) reads 9; New York reads 4.
    const AT_8Z = Date.parse('2026-10-14T08:00:00.000Z')
    // 2026-10-14 07:00Z: London (BST) reads 8.
    const at = (nowMs: number) => findDigestCandidates(db as never, nowMs)
    const only = async (nowMs: number, userId: string) => (await at(nowMs)).filter((c) => c.userId === userId)

    beforeEach(() => {
      reset('member', [{ id: 'm-here', user_id: 'u-p', workspace_id: WS, time_zone: null }])
      reset('user_profiles', [])
    })

    it('1. takes the person\'s own zone saved in another workspace (the browser zone, saved there)', async () => {
      reset('member', [
        { id: 'm-here', user_id: 'u-p', workspace_id: WS, time_zone: null },
        { id: 'm-there', user_id: 'u-p', workspace_id: 'w2', time_zone: 'Europe/London' },
      ])
      reset('user_profiles', [{ id: 'up1', user_id: 'u-p', timezone: 'America/New_York' }])
      const got = await only(SUMMER_7Z, 'u-p')
      expect(got).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ memberId: 'm-here', timeZone: 'Europe/London', timeZoneSource: 'other_workspace', date: '2026-10-14' }),
        ]),
      )
      expect(got).toHaveLength(2)
      expect(await only(AT_8Z, 'u-p')).toEqual([])
    })

    it('2. else the legacy profile zone', async () => {
      reset('user_profiles', [{ id: 'up1', user_id: 'u-p', timezone: 'Europe/London' }])
      expect(await only(SUMMER_7Z, 'u-p')).toEqual([
        expect.objectContaining({ memberId: 'm-here', timeZone: 'Europe/London', timeZoneSource: 'profile' }),
      ])
      expect(await only(AT_8Z, 'u-p')).toEqual([])
    })

    it('a bad profile zone is skipped like a bad member zone', async () => {
      reset('user_profiles', [{ id: 'up1', user_id: 'u-p', timezone: 'Mars/Olympus' }])
      expect(await only(AT_8Z, 'u-p')).toEqual([expect.objectContaining({ timeZone: 'UTC', timeZoneSource: 'utc' })])
    })

    it('3. else UTC, still scheduled (8:00 UTC)', async () => {
      expect(await only(SUMMER_7Z, 'u-p')).toEqual([])
      expect(await only(AT_8Z, 'u-p')).toEqual([
        expect.objectContaining({ memberId: 'm-here', timeZone: 'UTC', timeZoneSource: 'utc', date: '2026-10-14' }),
      ])
    })

    it('the member\'s own zone here always wins', async () => {
      reset('member', [
        { id: 'm-here', user_id: 'u-p', workspace_id: WS, time_zone: 'America/New_York' },
        { id: 'm-there', user_id: 'u-p', workspace_id: 'w2', time_zone: 'Europe/London' },
      ])
      expect((await only(SUMMER_7Z, 'u-p')).map((c) => c.memberId)).toEqual(['m-there'])
    })
  })
})

describe('pickTimeZone', () => {
  it('member here, then another workspace, then the profile, then UTC; unchecked zones skipped', () => {
    expect(pickTimeZone({ member: 'Europe/London', otherWorkspace: 'Asia/Tokyo', profile: 'America/New_York' })).toEqual({
      timeZone: 'Europe/London',
      source: 'member',
    })
    expect(pickTimeZone({ member: null, otherWorkspace: 'Asia/Tokyo', profile: 'America/New_York' })).toEqual({
      timeZone: 'Asia/Tokyo',
      source: 'other_workspace',
    })
    expect(pickTimeZone({ member: 'Mars/Olympus', profile: 'America/New_York' })).toEqual({
      timeZone: 'America/New_York',
      source: 'profile',
    })
    expect(pickTimeZone({ profile: 'Not a zone' })).toEqual({ timeZone: 'UTC', source: 'utc' })
    expect(pickTimeZone({})).toEqual({ timeZone: 'UTC', source: 'utc' })
  })
})

describe('resolveMemberTimeZone (the home turn\'s body zone)', () => {
  it('walks the same chain', async () => {
    reset('member', [
      { id: 'm-here', user_id: 'u-p', workspace_id: WS, time_zone: null },
      { id: 'm-there', user_id: 'u-p', workspace_id: 'w2', time_zone: 'Asia/Tokyo' },
    ])
    expect(await resolveMemberTimeZone(db as never, { userId: 'u-p', memberTimeZone: 'Europe/London' })).toEqual({
      timeZone: 'Europe/London',
      source: 'member',
    })
    expect(await resolveMemberTimeZone(db as never, { userId: 'u-p', memberTimeZone: null })).toEqual({
      timeZone: 'Asia/Tokyo',
      source: 'other_workspace',
    })
    reset('member', [{ id: 'm-here', user_id: 'u-p', workspace_id: WS, time_zone: null }])
    reset('user_profiles', [{ id: 'up1', user_id: 'u-p', timezone: 'America/New_York' }])
    expect(await resolveMemberTimeZone(db as never, { userId: 'u-p', memberTimeZone: null })).toEqual({
      timeZone: 'America/New_York',
      source: 'profile',
    })
    reset('user_profiles', [])
    expect(await resolveMemberTimeZone(db as never, { userId: 'u-p', memberTimeZone: null })).toEqual({ timeZone: 'UTC', source: 'utc' })
  })
})

describe('planDigestFor', () => {
  it('requests one home turn: reason digest, the event ids and the local date, keyed per conversation and day', async () => {
    db.seed('agent_event', [event({}), event({ kind: 'work.needs_review', facts: { title: 'Prospects' } })])
    const r = await planDigestFor(db as never, cand(), open, SUMMER_7Z)
    expect(r).toEqual({
      ok: true,
      request: {
        id: `home-turn-digest:${CONV}:2026-10-14`,
        name: 'home/turn.requested',
        data: { conversationId: CONV, userId: USER, workspaceId: WS, workItemIds: [], reason: 'digest', eventIds: expect.arrayContaining(['1', '2']), digestDate: '2026-10-14' },
      },
    })
  })

  it('log lines alone are something to say', async () => {
    db.seed('agent_log', [{ id: 1, workspace_id: WS, user_id: USER, at: ago(SUMMER_7Z, 120), kind: 'work_done', line: 'Finished: Weekly report', ref_type: null, ref_id: null }])
    const r = await planDigestFor(db as never, cand(), open, SUMMER_7Z)
    expect(r).toMatchObject({ ok: true, request: { data: { eventIds: [] } } })
  })

  it('skips with nothing to say: no undelivered row, no log line since the last digest', async () => {
    db.seed('agent_event', [event({ delivered_at: ago(SUMMER_7Z, 30), delivered_key: 'away:x', state: 'delivered' }), event({ outcome: 'ignore' })])
    db.seed('home_turn', [{ id: 'old', conversation_id: CONV, reason: 'digest', status: 'done', dedupe_key: 'digest:2026-10-13', created_at: ago(SUMMER_7Z, 60 * 24) }])
    db.seed('agent_log', [{ id: 1, workspace_id: WS, user_id: USER, at: ago(SUMMER_7Z, 60 * 25), kind: 'work_done', line: 'Old', ref_type: null, ref_id: null }])
    expect(await planDigestFor(db as never, cand(), open, SUMMER_7Z)).toEqual({ ok: false, reason: 'nothing_new' })
  })

  it.each([
    ['no home thread', () => reset('chat_conversations', []), open, 'no_home_thread'],
    ['today’s turn already there', () => db.seed('home_turn', [{ id: 't', conversation_id: CONV, dedupe_key: 'digest:2026-10-14', status: 'done' }]), open, 'already_sent'],
    ['today’s turn skipped (usage) is not retried this hour', () => db.seed('home_turn', [{ id: 't', conversation_id: CONV, dedupe_key: 'digest:2026-10-14', status: 'skipped' }]), open, 'already_sent'],
    ['autonomy off', () => {}, { ...open, pausedState: async () => 'paused' as const }, 'paused'],
    // The kill switch FAILS CLOSED here (A6 review): an unreadable switch is off, as the mail arrival path has it.
    ['an unreadable kill switch (fail closed: this spends money)', () => {}, { ...open, pausedState: async () => 'unknown' as const }, 'paused'],
    ['a dormant workspace', () => {}, { ...open, isDormant: async () => true }, 'dormant'],
  ])('skips %s', async (_label, arrange, deps, reason) => {
    db.seed('agent_event', [event({})])
    arrange()
    expect(await planDigestFor(db as never, cand(), deps, SUMMER_7Z)).toEqual({ ok: false, reason })
  })

  it('a failed turn for today may go again', async () => {
    db.seed('agent_event', [event({})])
    db.seed('home_turn', [{ id: 't', conversation_id: CONV, dedupe_key: 'digest:2026-10-14', status: 'failed' }])
    expect(await planDigestFor(db as never, cand(), open, SUMMER_7Z)).toMatchObject({ ok: true })
  })

  it('a paused check that throws reads as paused (the kill switch fails closed)', async () => {
    db.seed('agent_event', [event({})])
    expect(await planDigestFor(db as never, cand(), { ...open, pausedState: async () => { throw new Error('x') } }, SUMMER_7Z)).toEqual({ ok: false, reason: 'paused' })
  })
})

describe('gatherDigest / digestBody', () => {
  it('undelivered quiet/notify rows (not expired, only those named) plus log lines since the last digest no row stands for', async () => {
    db.seed('agent_event', [
      event({ id: '10', kind: 'email.drafted', facts: { from: 'pricing@acme.com' }, occurs_at: ago(SUMMER_7Z, 300) }),
      event({ id: '11', kind: 'work.needs_input', outcome: 'notify', facts: { title: 'Acme list' }, occurs_at: ago(SUMMER_7Z, 200), ref_type: 'work_item', ref_id: 'w-1' }),
      event({ id: '12', kind: 'meeting.soon', facts: { title: 'Standup' }, expires_at: ago(SUMMER_7Z, 600) }),
      event({ id: '13', kind: 'capture.processed', facts: { title: 'Not named' } }),
    ])
    // The question is still open (the freshness re-check reads it).
    db.seed('tracked_job', [{ id: 'w-1', workspace_id: WS, status: 'needs_input' }])
    db.seed('home_turn', [{ id: 'old', conversation_id: CONV, reason: 'digest', status: 'done', dedupe_key: 'digest:2026-10-13', created_at: ago(SUMMER_7Z, 60 * 6) }])
    db.seed('agent_log', [
      { id: 1, workspace_id: WS, user_id: USER, at: ago(SUMMER_7Z, 100), kind: 'work_needs_input', line: 'Waiting: Acme list', ref_type: 'work_item', ref_id: 'w-1' },
      { id: 2, workspace_id: WS, user_id: USER, at: ago(SUMMER_7Z, 90), kind: 'work_started', line: 'Started: Q4 deck', ref_type: 'work_item', ref_id: 'w-2' },
      { id: 3, workspace_id: WS, user_id: USER, at: ago(SUMMER_7Z, 60 * 7), kind: 'work_done', line: 'Before the last digest', ref_type: null, ref_id: null },
      { id: 4, workspace_id: WS, user_id: USER, at: ago(SUMMER_7Z, 10), kind: 'chat_checkpoint', line: 'checkpoint', ref_type: null, ref_id: null },
      // The morning tidy's own message says it: never a digest line.
      { id: 5, workspace_id: WS, user_id: USER, at: ago(SUMMER_7Z, 20), kind: 'mail_archived', line: 'Archived 14 receipts and notifications', ref_type: 'email_auto_archive', ref_id: 'b-1' },
    ])
    const g = await gatherDigest(db as never, { workspaceId: WS, userId: USER, conversationId: CONV, date: '2026-10-14', nowMs: SUMMER_7Z, eventIds: ['10', '11', '12'] })
    expect(g.events.map((e) => e.id).sort()).toEqual(['10', '11'])
    expect(g.logLines.map((l) => l.line)).toEqual(['Started: Q4 deck'])
    const body = digestBody(g, { date: '2026-10-14', timeZone: 'Europe/London' })!
    expect(body.counts).toEqual(['1 waiting on you', '1 draft ready', '1 log line'])
    expect(body.lines[0]).toBe('- 2026-10-14 04:40 Waiting on you: Acme list (it has a question)')
    expect(body.lines[1]).toContain('Draft ready: reply to pricing@acme.com')
    expect(body.lines[2]).toContain('Started: Q4 deck')
    expect(body.eventIds.sort()).toEqual(['10', '11'])
    expect(digestBody({ events: [], logLines: [] }, { date: '2026-10-14', timeZone: 'UTC' })).toBeNull()
  })

  it('drops what settled since (a draft sent, a question answered, an approval decided) and marks it so; keeps what is still open; one line per item', async () => {
    db.seed('agent_event', [
      event({ id: '30', kind: 'email.drafted', facts: { title: 'Sent already' }, ref_type: 'email_draft', ref_id: 'd-sent' }),
      event({ id: '31', kind: 'email.drafted', facts: { title: 'Still open' }, ref_type: 'email_draft', ref_id: 'd-open' }),
      event({ id: '32', kind: 'work.needs_input', outcome: 'notify', facts: { title: 'Answered' }, ref_type: 'work_item', ref_id: 'w-answered' }),
      event({ id: '33', kind: 'work.needs_review', facts: { title: 'Still waiting' }, ref_type: 'work_item', ref_id: 'w-review' }),
      event({ id: '34', kind: 'work.done', facts: { title: 'Still waiting' }, ref_type: 'work_item', ref_id: 'w-review', occurs_at: ago(SUMMER_7Z, 5) }),
      event({ id: '35', kind: 'work.approval', outcome: 'turn', facts: { title: 'Approve send?' }, ref_type: 'tool_approval', ref_id: 'ap-1' }),
      event({ id: '36', kind: 'email.needs_reply', facts: { title: 'Replied' }, ref_type: 'email_thread', ref_id: 'pt-1' }),
    ])
    db.seed('email_draft', [
      { id: 'd-sent', workspace_id: WS, status: 'sent' },
      { id: 'd-open', workspace_id: WS, status: 'pending_review' },
    ])
    db.seed('tracked_job', [
      { id: 'w-answered', workspace_id: WS, status: 'running' },
      { id: 'w-review', workspace_id: WS, status: 'needs_review' },
    ])
    db.seed('tool_approval', [{ id: 'ap-1', user_id: USER, status: 'approved', expires_at: ago(SUMMER_7Z, -60) }])
    db.seed('email_thread_index', [{ id: 'ti-1', workspace_id: WS, user_id: USER, provider_thread_id: 'pt-1', needs_reply: false }])
    const g = await gatherDigest(db as never, { workspaceId: WS, userId: USER, conversationId: CONV, date: '2026-10-14', nowMs: SUMMER_7Z })
    expect(g.events.map((e) => e.id).sort()).toEqual(['31', '33'])
    // The finish rides along with its review (one line per item), delivered together.
    expect([...(g.carriedIds ?? [])].sort()).toEqual(['31', '33', '34'])
    const body = digestBody(g, { date: '2026-10-14', timeZone: 'UTC' })!
    expect(body.lines.join('\n')).not.toContain('Sent already')
    expect(body.lines.join('\n')).not.toContain('Answered')
    expect(body.counts).toEqual(['1 waiting on you', '1 draft ready'])
    const settled = db.rows('agent_event').filter((r) => r.delivered_key === 'settled').map((r) => r.id).sort()
    expect(settled).toEqual(['30', '32', '35', '36'])
  })

  it('a retried turn re-reads the rows it already marked for the day', async () => {
    db.seed('agent_event', [event({ id: '20', delivered_at: ago(SUMMER_7Z, 1), delivered_key: 'digest:2026-10-14', state: 'delivered' })])
    const g = await gatherDigest(db as never, { workspaceId: WS, userId: USER, conversationId: CONV, date: '2026-10-14', nowMs: SUMMER_7Z })
    expect(g.events.map((e) => e.id)).toEqual(['20'])
  })
})

describe('markDigestDelivered', () => {
  it('marks only the named, undelivered rows of this person, with the day’s key and the home turn', async () => {
    db.seed('agent_event', [
      event({ id: '1' }),
      event({ id: '2', delivered_at: ago(SUMMER_7Z, 5), delivered_key: 'away:m', state: 'delivered' }),
      event({ id: '3', user_id: 'someone-else' }),
      event({ id: '4' }),
    ])
    const n = await markDigestDelivered(db as never, { workspaceId: WS, userId: USER, eventIds: ['1', '2', '3'], date: '2026-10-14', homeTurnId: 'ht-1', nowMs: SUMMER_7Z })
    expect(n).toBe(1)
    const rows = Object.fromEntries(db.rows('agent_event').map((r) => [r.id, r]))
    expect(rows['1']).toMatchObject({ state: 'delivered', delivered_key: 'digest:2026-10-14', home_turn_id: 'ht-1' })
    expect(rows['2']).toMatchObject({ delivered_key: 'away:m' })
    expect(rows['3']).toMatchObject({ delivered_at: null })
    expect(rows['4']).toMatchObject({ delivered_at: null })
    expect(await markDigestDelivered(db as never, { workspaceId: WS, userId: USER, eventIds: [], date: '2026-10-14', homeTurnId: 'ht-1' })).toBe(0)
  })
})

describe('sendDigestNotice', () => {
  const digest = { date: '2026-10-14', timeZone: 'Europe/London', counts: ['1 waiting on you', '2 drafts ready', '1 failed', '3 finished'], lines: [], eventIds: [] }

  it('sends ONE agent_digest notice per day from the Assistant, in Native Intelligence’s own words', async () => {
    const id = await sendDigestNotice(db as never, { workspaceId: WS, userId: USER, conversationId: CONV, homeTurnId: 'ht-1', digest })
    expect(id).toBe('n-1')
    expect(notify.rows).toHaveLength(1)
    expect(notify.rows[0]).toMatchObject({
      recipient_id: 'm1',
      type: 'agent_digest',
      group_key: 'agent_digest:2026-10-14',
      body: 'Your morning digest is in our thread: 1 waiting on you · 2 drafts ready · 1 failed.',
      metadata: expect.objectContaining({ teammate_id: 'assistant-1', conversation_id: CONV, home_turn_id: 'ht-1', digest_date: '2026-10-14' }),
    })
    // Again the same day: the one already out, nothing new.
    expect(await sendDigestNotice(db as never, { workspaceId: WS, userId: USER, conversationId: CONV, homeTurnId: 'ht-2', digest })).toBe('n-1')
    expect(notify.rows).toHaveLength(1)
  })

  it('no member row: no notice', async () => {
    reset('member', [])
    expect(await sendDigestNotice(db as never, { workspaceId: WS, userId: USER, conversationId: CONV, homeTurnId: 'ht-1', digest })).toBeNull()
    expect(notify.rows).toHaveLength(0)
    expect(digestNoticeCopy({ counts: [] }).sentence).toBe('Your morning digest is in our thread.')
  })
})

describe('the home turn’s plan for a digest', () => {
  const data = { conversationId: CONV, userId: USER, workspaceId: WS, workItemIds: [], reason: 'digest' as const, digestDate: '2026-10-14', eventIds: ['1'] }
  const deps = { checkUsage: async () => undefined, peekTail: async () => ({ tailIndex: 9, events: [] }), now: SUMMER_7Z }

  it('re-reads the named rows in the person’s zone and keys the turn on the day', async () => {
    db.seed('agent_event', [event({ id: '1', kind: 'work.failed', facts: { title: 'Sync' } }), event({ id: '2' })])
    const plan = await planHomeTurn(db as never, data, deps)
    expect(plan).toMatchObject({ ok: true, sessionId: 'sess-home', fromIndex: 10, reports: [], workItemIds: [], dedupeKey: 'digest:2026-10-14' })
    const digest = (plan as { digest: { eventIds: string[]; timeZone: string; counts: string[] } }).digest
    expect(digest.eventIds).toEqual(['1'])
    expect(digest.timeZone).toBe('Europe/London')
    expect(digest.counts).toEqual(['1 failed'])
  })

  it('nothing new (the rows were delivered meanwhile, no log): no turn', async () => {
    db.seed('agent_event', [event({ id: '1', delivered_at: ago(SUMMER_7Z, 1), delivered_key: 'away:z', state: 'delivered' })])
    expect(await planHomeTurn(db as never, data, deps)).toEqual({ ok: false, reason: 'nothing_new' })
  })

  it('autonomy off holds for a digest too (recorded as a skipped turn for the day)', async () => {
    db.seed('agent_event', [event({ id: '1' })])
    reset('workspace', [{ id: WS, settings: { agent_autonomy: { mode: 'off' } } }])
    expect(await planHomeTurn(db as never, data, deps)).toMatchObject({ ok: false, reason: 'autonomy_off', record: { dedupeKey: 'digest:2026-10-14', reports: [] } })
  })

  it('the request the cron builds parses as the consumer reads it', async () => {
    const { parseHomeTurnRequested } = await import('@/lib/chat/home-turn')
    const req = digestRequest(CONV, cand(), ['1', '2'])
    expect(parseHomeTurnRequested(req.data)).toEqual(req.data)
  })
})

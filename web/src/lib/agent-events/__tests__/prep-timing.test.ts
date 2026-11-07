/**
 * Prep lands about 30 minutes before each meeting (Liam, 2026-10-15: "things
 * can change up until like 15 minutes before the call… I would like it if
 * they showed up like 30 minutes before"). The 5-minute meeting pass
 * (meeting-pass.ts, agentEventMeetingSoon) reads the live calendar each tick
 * and starts a meeting's prep on the first pass inside (now + 5 min,
 * now + 30 min].
 *
 * Driven tick by tick under fake time (Date only), over a calendar the test
 * edits between ticks. Pinned:
 *   • the window: a meeting at :00 is prepped at T−30, an off-grid one on the
 *     first tick under 30 minutes, never earlier;
 *   • back-to-back meetings each get their own prep at their own T−30; two at
 *     the same start take turns (one prep working at a time);
 *   • reschedule: a meeting moved before its prep is prepped for its new time
 *     only; one moved after its prep gets a fresh prep for the new time;
 *   • cancel: a cancelled or deleted meeting gets nothing;
 *   • late-added: a meeting added under 30 minutes ahead is prepped on the
 *     next tick, unless it starts within 5 minutes;
 *   • idempotency: one prep per meeting occurrence (event id + start), however
 *     many ticks see it, a retried tick included;
 *   • the opt-outs: autonomy off (or unreadable), a dormant workspace and no
 *     home thread start nothing; declined, all-day and solo meetings get no
 *     prep; an internal meeting gets the lighter one (Liam, 2026-10-17);
 *   • one heads-up per meeting occurrence: "prep ready" when the prep made
 *     it (an internal meeting's too), plain when no prep is coming (refused
 *     for good), never both; a solo block gets none; the same meeting twice
 *     on the desktop calendar is one meeting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import type { CalendarEvent } from '@/lib/integrations/calendar'
import type { ServerHelperStart } from '@/lib/chat/start-helper'
import { meetingPassFor, type MeetingPassDeps } from '../meeting-pass'
import { PREP_LEAD_MS, PREP_MIN_LEAD_MS } from '../meeting-prep'
import { prepCallId } from '../meeting-soon'
import { meetingKey, type AccountRead } from '../upcoming-meetings'

/** 09:00 New York; ticks are minutes after it, on the 5-minute grid. */
const BASE = Date.parse('2026-10-15T13:00:00.000Z')
const at = (min: number) => BASE + min * 60_000
const iso = (min: number) => new Date(at(min)).toISOString()
const ME = 'me@us.example'

let db: FakeSupabase
let calendar: CalendarEvent[]
/** fire key → run id, as start_chat_helper keys its runs. */
let runs: Map<string, string>
let started: Array<{ subject: string; callId: string; atMin: number }>
let person: { workspaceId: string; userId: string; conversationId: string }
const send = vi.fn(async () => ({}))

const evt = (id: string, startMin: number, over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id,
  title: `Meeting ${id}`,
  start: iso(startMin),
  end: iso(startMin + 30),
  attendees: [ME, `guest@${id}.example`],
  ...over,
})
const setEvent = (id: string, over: Partial<CalendarEvent> | null) => {
  const i = calendar.findIndex((e) => e.id === id)
  if (over === null) calendar.splice(i, 1)
  else calendar[i] = { ...calendar[i], ...over }
}

/** start_chat_helper as far as this path sees it: its idempotency key, one prep working per person. */
async function startHelper(supabase: unknown, start: ServerHelperStart): Promise<Record<string, unknown>> {
  const key = `chat-helper:${start.conversationId}:session:${start.scope}:turn:${start.subject}:call:${start.callId}`
  const existing = runs.get(key)
  if (existing) return { status: 'running', run_id: existing, work_item_id: `item-${existing}`, reused: true }
  if (db.rows('agent_run').some((r) => r.triggered_by === start.userId && r.status === 'running')) return { status: 'refused', code: 'SERVER_LIVE' }
  const id = `run-${runs.size + 1}`
  runs.set(key, id)
  db.seed('agent_run', [{ id, workspace_id: start.workspaceId, triggered_by: start.userId, status: 'running', server_helper: 'meeting_prep', fire_key: key }])
  started.push({ subject: String(start.subject), callId: String(start.callId), atMin: (Date.now() - BASE) / 60_000 })
  return { status: 'started', run_id: id, work_item_id: `item-${id}`, reused: false }
}

const listAccount = vi.fn(async (): Promise<AccountRead> => ({ events: calendar.map((e) => ({ ...e })) }))
const deps = (over: Partial<MeetingPassDeps> = {}): MeetingPassDeps => ({
  pausedState: async () => 'active',
  isDormant: async () => false,
  startHelper: startHelper as MeetingPassDeps['startHelper'],
  listAccount,
  memberEmails: async () => new Set(['teammate@us.example']),
  record: { send },
  // Jev's check says prep: the timing is pinned here, the check in meeting-prep-check.test.ts.
  decidePrep: async () => ({ status: 'accepted', value: 'prep', inferenceId: 'inf', version: 'v' }),
  ...over,
})

/** A prep takes a minute or two: everything working settles (its work item waits on review) before the next tick. */
const settle = () => {
  for (const r of db.rows('agent_run')) {
    if (r.status !== 'running') continue
    r.status = 'completed'
    db.seed('tracked_job', [{ id: `job-${r.id}`, agent_run_id: r.id, status: 'needs_review' }])
  }
}
/** One 5-minute tick at `min`. */
async function tick(min: number, d: MeetingPassDeps = deps()) {
  vi.setSystemTime(at(min))
  const out = await meetingPassFor(db as never, person, d)
  return out
}
/** Ticks every 5 minutes over [from, to], the prep of each settling before the next. */
async function ticks(from: number, to: number, d?: MeetingPassDeps) {
  for (let m = from; m <= to; m += 5) {
    await tick(m, d)
    settle()
  }
}
const key = (id: string) => meetingKey('calendar_event', id)
const prepsFor = (id: string) => started.filter((s) => s.subject === key(id))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(BASE)
  db = makeFakeSupabase()
  db.seed('connected_account', [{ id: 'a1', user_id: 'u1', workspace_id: 'w1', provider: 'google', capability: 'calendar', is_enabled: true, account_email: ME }])
  calendar = []
  runs = new Map()
  started = []
  person = { workspaceId: 'w1', userId: 'u1', conversationId: 'home' }
  listAccount.mockClear()
  send.mockClear()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the window: about 30 minutes before', () => {
  it('the lead is 30 minutes and the floor 5', () => {
    expect(PREP_LEAD_MS).toBe(30 * 60_000)
    expect(PREP_MIN_LEAD_MS).toBe(5 * 60_000)
  })

  it('a 10:00 meeting is prepped at 9:30, not at the start of the day or 2 hours ahead', async () => {
    calendar = [evt('ten', 60)]
    await ticks(0, 60)
    expect(prepsFor('ten')).toEqual([{ subject: key('ten'), callId: prepCallId(iso(60)), atMin: 30 }])
  })

  it('an off-grid meeting (10:07) is prepped on the first tick under 30 minutes (9:40)', async () => {
    calendar = [evt('odd', 67)]
    await ticks(0, 65)
    expect(prepsFor('odd').map((s) => s.atMin)).toEqual([40])
  })

  it('one calendar read covers the next day (the meeting-changes watch); prep still waits for its T−30', async () => {
    calendar = [evt('ten', 60)]
    await tick(0)
    expect(listAccount).toHaveBeenCalledTimes(1)
    expect(listAccount).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }), expect.objectContaining({ timeMin: iso(0), timeMax: iso(24 * 60) }))
    // The meeting an hour out is read, but nothing starts for it before T−30.
    expect(started).toEqual([])
  })
})

describe('back-to-back meetings', () => {
  it('each gets its own prep at its own T−30', async () => {
    calendar = [evt('a', 60), evt('b', 90), evt('c', 120)]
    await ticks(0, 120)
    expect(started.map((s) => [s.subject, s.atMin])).toEqual([
      [key('a'), 30],
      [key('b'), 60],
      [key('c'), 90],
    ])
  })

  it('two at the same start take turns: the second starts on the next tick', async () => {
    calendar = [evt('x', 60), evt('y', 60)]
    await tick(30)
    expect(started.map((s) => s.subject)).toEqual([key('x')])
    settle()
    await tick(35)
    expect(started.map((s) => [s.subject, s.atMin])).toEqual([
      [key('x'), 30],
      [key('y'), 35],
    ])
  })
})

describe('reschedule', () => {
  it('moved before its prep: prepped for the new time only', async () => {
    calendar = [evt('m', 60)]
    await ticks(0, 20)
    setEvent('m', { start: iso(120), end: iso(150) })
    await ticks(25, 120)
    expect(prepsFor('m')).toEqual([{ subject: key('m'), callId: prepCallId(iso(120)), atMin: 90 }])
  })

  it('moved after its prep: a fresh prep for the new time; the old time is never prepped again', async () => {
    calendar = [evt('m', 60)]
    await ticks(0, 35)
    setEvent('m', { start: iso(150), end: iso(180) })
    await ticks(40, 150)
    expect(prepsFor('m').map((s) => [s.callId, s.atMin])).toEqual([
      [prepCallId(iso(60)), 30],
      [prepCallId(iso(150)), 120],
    ])
  })

  it('moved earlier into the window: prepped on the next tick for the new time', async () => {
    calendar = [evt('m', 120)]
    await ticks(0, 40)
    setEvent('m', { start: iso(62), end: iso(90) })
    await ticks(45, 62)
    expect(prepsFor('m').map((s) => [s.callId, s.atMin])).toEqual([[prepCallId(iso(62)), 45]])
  })
})

describe('cancel', () => {
  it('a cancelled meeting gets nothing', async () => {
    calendar = [evt('c', 60)]
    await ticks(0, 20)
    setEvent('c', { status: 'cancelled' })
    await ticks(25, 60)
    expect(started).toEqual([])
  })

  it('a deleted meeting gets nothing', async () => {
    calendar = [evt('d', 60)]
    await ticks(0, 25)
    setEvent('d', null)
    await ticks(30, 60)
    expect(started).toEqual([])
    expect(db.rows('agent_event')).toEqual([])
  })
})

describe('late-added meetings', () => {
  it('added 12 minutes ahead: prepped on the next tick', async () => {
    await ticks(0, 45)
    calendar = [evt('late', 60)]
    await ticks(50, 60)
    expect(prepsFor('late').map((s) => s.atMin)).toEqual([50])
  })

  it('starting within 5 minutes when first seen: no prep (too late to help)', async () => {
    await ticks(0, 55)
    calendar = [evt('now', 64)]
    await ticks(60, 65)
    expect(started).toEqual([])
    // It still gets its meeting-soon row.
    expect(db.rows('agent_event').map((r) => r.kind)).toEqual(['meeting.soon'])
  })
})

describe('idempotency', () => {
  it('one prep per meeting occurrence, however many ticks see it (a retried tick included), even before it settles', async () => {
    calendar = [evt('once', 60)]
    await tick(30)
    // A retried step, the prep still working.
    await tick(30)
    await tick(35)
    settle()
    await ticks(40, 60)
    expect(prepsFor('once')).toHaveLength(1)
    expect(runs.size).toBe(1)
  })

  it('a renamed meeting is the same occurrence (no second prep)', async () => {
    calendar = [evt('r', 60)]
    await ticks(25, 35)
    setEvent('r', { title: 'Renamed' })
    await ticks(40, 60)
    expect(prepsFor('r')).toHaveLength(1)
  })
})

describe('one heads-up per meeting occurrence (PROD audit, 2026-10-15)', () => {
  const headsUps = () => db.rows('agent_event').map((r) => ({ key: String(r.dedupe_key), prepReady: (r.facts as { prepReady?: boolean }).prepReady }))

  it('a prepped meeting gets exactly one heads-up, saying its prep is ready (no plain row first)', async () => {
    calendar = [evt('ten', 60)]
    await ticks(0, 60)
    expect(headsUps()).toEqual([{ key: `meeting:${key('ten')}:${iso(60)}:prep`, prepReady: true }])
  })

  it('an internal meeting gets its lighter prep at T−30, and one heads-up saying it is ready', async () => {
    calendar = [evt('internal', 60, { attendees: [ME, 'teammate@us.example'] })]
    await ticks(0, 25)
    expect(headsUps()).toEqual([])
    await ticks(30, 60)
    expect(prepsFor('internal').map((s) => s.atMin)).toEqual([30])
    expect(headsUps()).toEqual([{ key: `meeting:${key('internal')}:${iso(60)}:prep`, prepReady: true }])
  })

  it('a solo calendar block gets no prep and no heads-up', async () => {
    calendar = [evt('focus', 60, { attendees: [ME] })]
    await ticks(0, 60)
    expect(started).toEqual([])
    expect(headsUps()).toEqual([])
  })

  it('a prep the RPC refuses for good (the daily cap) does not hold the heads-up: plain, at once', async () => {
    calendar = [evt('capped', 60)]
    await ticks(30, 60, deps({ startHelper: (async () => ({ status: 'refused', code: 'SERVER_DAY_BUDGET' })) as MeetingPassDeps['startHelper'] }))
    expect(headsUps()).toEqual([{ key: `meeting:${key('capped')}:${iso(60)}`, prepReady: false }])
  })

  it('two meetings at once: the one waiting for its turn (SERVER_LIVE) holds its heads-up and gets its prep next tick; each one heads-up', async () => {
    calendar = [evt('x', 60), evt('y', 60)]
    await ticks(30, 60)
    expect(started.map((s) => [s.subject, s.atMin])).toEqual([
      [key('x'), 30],
      [key('y'), 35],
    ])
    expect(headsUps()).toEqual([
      { key: `meeting:${key('x')}:${iso(60)}:prep`, prepReady: true },
      { key: `meeting:${key('y')}:${iso(60)}:prep`, prepReady: true },
    ])
  })

  it('the same meeting twice on the desktop calendar (two local ids, same title and start) is one meeting: one prep, one heads-up', async () => {
    const local = (id: string) => ({ id, external_id: id, title: 'Acme renewal', user_id: 'u1', workspace_id: 'w1', start_at: iso(60), end_at: iso(90), is_all_day: false, synced_at: iso(-10), attendees: [ME, 'dana@acme.example'] })
    db.seed('local_calendar_event', [local('ek-1'), local('ek-2')])
    await ticks(0, 60)
    expect(started.map((s) => s.subject)).toEqual([meetingKey('local_calendar_event', 'ek-1')])
    expect(headsUps()).toHaveLength(1)
  })
})

describe('opt-outs and the rules for which meetings', () => {
  it('autonomy off (or unreadable): no calendar read, no prep; back on inside the window, the prep starts on the next tick', async () => {
    calendar = [evt('p', 60)]
    await ticks(25, 35, deps({ pausedState: async () => 'paused' }))
    await ticks(40, 40, deps({ pausedState: async () => 'unknown' }))
    expect(listAccount).not.toHaveBeenCalled()
    expect(started).toEqual([])
    await ticks(45, 60)
    expect(prepsFor('p').map((s) => s.atMin)).toEqual([45])
  })

  it('a dormant workspace starts nothing', async () => {
    calendar = [evt('p', 60)]
    await ticks(0, 60, deps({ isDormant: async () => true }))
    expect(started).toEqual([])
  })

  it('no home thread starts nothing', async () => {
    person = { ...person, conversationId: '' }
    calendar = [evt('p', 60)]
    await ticks(25, 60)
    expect(started).toEqual([])
  })

  it('declined, all-day and solo meetings get no prep; the external one does, and the internal one its lighter prep', async () => {
    calendar = [
      evt('declined', 60, { attendeeDetails: [{ email: ME, responseStatus: 'declined' }, { email: 'guest@x.example', responseStatus: 'accepted' }] }),
      // Microsoft Graph's word for it, with the address in another case.
      evt('declined-ms', 60, { attendeeDetails: [{ email: 'Me@Us.Example', responseStatus: 'Declined' }] }),
      evt('allday', 60, { isAllDay: true }),
      evt('internal', 60, { attendees: [ME, 'teammate@us.example'] }),
      evt('solo', 60, { attendees: [ME] }),
      evt('ok', 60, { attendeeDetails: [{ email: ME, responseStatus: 'accepted' }] }),
    ]
    await ticks(25, 60)
    // One prep working at a time: the internal one at T−30, the external one the tick after.
    expect(started.map((s) => s.subject)).toEqual([key('internal'), key('ok')])
    // A declined meeting gets no meeting-soon row either.
    const rows = db.rows('agent_event').map((r) => String(r.dedupe_key))
    expect(rows.some((k) => k.includes(key('declined')) || k.includes(key('declined-ms')))).toBe(false)
  })
})

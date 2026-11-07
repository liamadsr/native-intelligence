/**
 * Meeting prep and meeting-soon read the CALENDAR (A6 review fix; src/lib/
 * agent-events/upcoming-meetings.ts, meeting-soon.ts, meeting-pass.ts).
 *
 * Pinned:
 *   • the input: the person's calendar events (provider and the desktop's
 *     local ones), not all-day or cancelled, plus pending captures with the
 *     eval fence (not demo, archived or is_eval), merged once per meeting;
 *   • each meeting's audience: external (someone not the person, not a
 *     member, not a room), internal (only members besides the person: the
 *     lighter prep), or none (a solo block: no prep); its series identity
 *     kept; its prep found again by its idempotency key, so a desktop event
 *     can be "prep ready";
 *   • the pass: meetings within 30 minutes become meeting.soon rows; meetings
 *     in (5 min, 30 min] with someone else invited and no prep start one
 *     helper each;
 *     a dormant workspace reads no calendar; an unreadable kill switch starts
 *     no prep (fail closed);
 *   • "prep ready" is its own row the moment prep is ready, from the next pass
 *     or from the prep settling, and the "no prep" row is retired.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import type { CalendarEvent } from '@/lib/integrations/calendar'
import { ACCOUNT_RETRY_AFTER_MS, MAX_EVENTS, listUpcomingMeetings, meetingAudiences, meetingKey, organizedBy, readMeetingWindow, workspaceCalendarAccounts, type AccountRead, type UpcomingMeeting } from '../upcoming-meetings'
import { meetingSoonEvent, meetingsStartingSoon, parsePrepFireKey, prepFireKey, prepStatusFor, recordPrepReadyForRun } from '../meeting-soon'
import { meetingPassFor, perWorkspace, type MeetingPassDeps } from '../meeting-pass'
import { agentEventKey } from '../types'
import { routeEvent } from '../router'

const NOW = Date.parse('2026-10-14T12:00:00.000Z')
const inMin = (m: number) => new Date(NOW + m * 60_000).toISOString()
const person = { workspaceId: 'w1', userId: 'u1', conversationId: 'home' }

let db: FakeSupabase
const send = vi.fn(async () => ({}))

beforeEach(() => {
  db = makeFakeSupabase()
  send.mockClear()
  db.seed('connected_account', [{ id: 'a1', user_id: 'u1', workspace_id: 'w1', provider: 'google', capability: 'calendar', is_enabled: true, account_email: 'me@us.example' }])
})

/** The account read, stubbed: these events for every account it is asked for. */
const reading = (events: CalendarEvent[]) => vi.fn(async (): Promise<AccountRead> => ({ events }))

const evt = (id: string, startMin: number, over: Partial<CalendarEvent> & { provider?: string } = {}): CalendarEvent =>
  ({ id, title: `Meeting ${id}`, start: inMin(startMin), end: inMin(startMin + 30), attendees: ['me@us.example', `guest@${id}.example`], ...over }) as CalendarEvent

describe('listUpcomingMeetings (the calendar is the input)', () => {
  it('calendar events and the desktop\'s, plus pending captures with the eval fence, once per meeting', async () => {
    db.seed('captures', [
      { id: 'cap-a', user_id: 'u1', workspace_id: 'w1', title: 'Meeting a', scheduled_start: inMin(30), calendar_event_id: 'a', auto_capture_status: 'pending', status: 'active', metadata: {} },
      { id: 'cap-only', user_id: 'u1', workspace_id: 'w1', title: 'Synced only', scheduled_start: inMin(40), calendar_event_id: 'gone', auto_capture_status: 'pending', status: 'active', metadata: {} },
      { id: 'cap-eval', user_id: 'u1', workspace_id: 'w1', title: 'Eval fixture', scheduled_start: inMin(40), auto_capture_status: 'pending', status: 'active', metadata: {}, is_eval: true },
      { id: 'cap-demo', user_id: 'u1', workspace_id: 'w1', title: 'Demo', scheduled_start: inMin(40), auto_capture_status: 'pending', status: 'active', metadata: { demo: true } },
      { id: 'cap-arch', user_id: 'u1', workspace_id: 'w1', title: 'Archived', scheduled_start: inMin(40), auto_capture_status: 'pending', status: 'archived', metadata: {} },
    ])
    const listAccount = reading([evt('a', 30), evt('allday', 60, { isAllDay: true }), evt('cancelled', 60, { status: 'cancelled' }), evt('late', 200)])
    db.seed('local_calendar_event', [
      { id: 'l1', external_id: 'local-1', title: 'Meeting local-1', user_id: 'u1', workspace_id: 'w1', start_at: inMin(20), end_at: inMin(50), is_all_day: false, synced_at: inMin(-60), attendees: ['me@us.example', 'x@y.example'] },
      // Filed under another workspace: not this one's.
      { id: 'l2', external_id: 'local-2', title: 'Other workspace', user_id: 'u1', workspace_id: 'w2', start_at: inMin(25), end_at: inMin(50), is_all_day: false, synced_at: inMin(-60), attendees: [] },
    ])
    const got = await listUpcomingMeetings(db as never, person, { fromMs: NOW, toMs: NOW + 2 * 60 * 60_000 }, { listAccount })
    expect(got.map((m) => [m.ref, m.id, m.captureId])).toEqual([
      ['local_calendar_event', 'local-1', null],
      ['calendar_event', 'a', 'cap-a'],
      ['capture', 'cap-only', 'cap-only'],
    ])
    expect(got[1].meetingKey).toBe(meetingKey('calendar_event', 'a'))
    expect(listAccount).toHaveBeenCalledWith({ id: 'a1', provider: 'google', failedAt: null, email: 'me@us.example' }, expect.objectContaining({ timeMin: inMin(0) }))
  })

  it('per workspace: an account linked to workspaces counts in those; an unlinked one only where it was connected; never both', async () => {
    db.seed('connected_account', [
      { id: 'a2', user_id: 'u1', workspace_id: 'w2', provider: 'microsoft', capability: 'calendar', is_enabled: true },
      { id: 'a3', user_id: 'u1', workspace_id: 'w2', provider: 'google', capability: 'calendar', is_enabled: true },
      { id: 'a4', user_id: 'u1', workspace_id: 'w1', provider: 'google', capability: 'calendar', is_enabled: false },
    ])
    // a3 was connected in w2 but is linked to w1 (and only w1).
    db.seed('connected_account_workspace', [{ account_id: 'a3', workspace_id: 'w1' }])
    expect((await workspaceCalendarAccounts(db as never, person, NOW)).map((a) => a.id).sort()).toEqual(['a1', 'a3'])
    expect((await workspaceCalendarAccounts(db as never, { workspaceId: 'w2', userId: 'u1' }, NOW)).map((a) => a.id)).toEqual(['a2'])
  })

  it('a gone token is marked and the account skipped for a day (not every 15 minutes); a good read clears the mark', async () => {
    const gone = vi.fn(async (): Promise<AccountRead> => 'no_token')
    await listUpcomingMeetings(db as never, person, { fromMs: NOW, toMs: NOW + 60 * 60_000 }, { listAccount: gone })
    expect(db.rows('connected_account')[0].agent_read_failed_at).toBe(inMin(0))
    gone.mockClear()
    await listUpcomingMeetings(db as never, person, { fromMs: NOW + 15 * 60_000, toMs: NOW + 75 * 60_000 }, { listAccount: gone })
    expect(gone).not.toHaveBeenCalled()
    const later = NOW + ACCOUNT_RETRY_AFTER_MS + 1
    await listUpcomingMeetings(db as never, person, { fromMs: later, toMs: later + 60 * 60_000 }, { listAccount: reading([]) })
    expect(db.rows('connected_account')[0].agent_read_failed_at).toBeNull()
  })

  it('no calendar connected (or a failed read): the captures still count', async () => {
    db.seed('captures', [{ id: 'c1', user_id: 'u1', workspace_id: 'w1', title: 'x', scheduled_start: inMin(30), auto_capture_status: 'pending', status: 'active', metadata: {} }])
    const got = await listUpcomingMeetings(db as never, person, { fromMs: NOW, toMs: NOW + 60 * 60_000 }, { listAccount: async () => { throw new Error('provider down') } })
    expect(got.map((m) => m.id)).toEqual(['c1'])
  })
})

describe('readMeetingWindow, a details read (the evening look-ahead)', () => {
  it('keeps all-day events with their date, and each event’s place, description and recurrence; a plain read stays as it was', async () => {
    const listAccount = reading([
      evt('rental', 30, { attendees: ['me@us.example'], organizer: 'me@us.example', location: 'Enterprise, 1250 Market St', description: 'Bring your license' }),
      evt('trip', 0, { isAllDay: true, start: '2026-10-15', end: '2026-10-16', title: 'Flight to NYC' }),
      evt('weekly', 45, { hasRecurrence: true }),
    ])
    db.seed('local_calendar_event', [
      { id: 'l1', external_id: 'local-1', title: 'Dentist', user_id: 'u1', workspace_id: 'w1', start_at: inMin(20), end_at: inMin(50), is_all_day: false, synced_at: inMin(-60), attendees: [], location: '450 Sutter St', description: null },
      { id: 'l2', external_id: 'local-2', title: 'Holiday', user_id: 'u1', workspace_id: 'w1', start_at: inMin(10), end_at: inMin(1440), is_all_day: true, synced_at: inMin(-60), attendees: [] },
    ])
    const window = { fromMs: NOW, toMs: NOW + 2 * 60 * 60_000 }
    const details = (await readMeetingWindow(db as never, person, window, { listAccount }, { details: true })).meetings
    const byId = new Map(details.map((m) => [m.id, m]))
    // The person's own event (they organize it): accepted. An invite they haven't answered is not.
    expect(byId.get('rental')).toMatchObject({ location: 'Enterprise, 1250 Market St', description: 'Bring your license', allDay: false, allDayDate: null, recurring: false })
    expect(byId.get('trip')).toMatchObject({ title: 'Flight to NYC', allDay: true, allDayDate: '2026-10-15' })
    expect(byId.get('weekly')).toMatchObject({ recurring: true, accepted: false })
    expect(byId.get('local-1')).toMatchObject({ location: '450 Sutter St', accepted: null })
    // The desktop's all-day start is local midnight: its date is read in the person's zone (look-ahead candidates.ts), not here.
    expect(byId.get('local-2')).toMatchObject({ allDay: true, allDayDate: null })
    const plain = (await readMeetingWindow(db as never, person, window, { listAccount })).meetings
    expect(plain.map((m) => m.id).sort()).toEqual(['local-1', 'rental', 'weekly'])
    expect(plain.every((m) => !('location' in m) && !('allDayDate' in m))).toBe(true)
  })
})

describe('readMeetingWindow (what the meeting-changes watch sees)', () => {
  it('reports cancelled and declined provider events apart from the meetings, with each meeting\'s account, organizer and other people', async () => {
    const listAccount = reading([
      evt('theirs', 30, { attendees: ['me@us.example', 'sam@them.example', 'room-1@resource.calendar.google.com'], organizer: 'sam@them.example' }),
      evt('mine', 40, { organizer: 'me@us.example' }),
      evt('cancelled', 50, { status: 'cancelled' }),
      evt('declined', 60, { attendeeDetails: [{ email: 'me@us.example', responseStatus: 'declined' }] }),
    ])
    const got = await readMeetingWindow(db as never, person, { fromMs: NOW, toMs: NOW + 24 * 60 * 60_000 }, { listAccount })
    expect(got.meetings.map((m) => [m.id, m.accountId, m.mine, m.others])).toEqual([['theirs', 'a1', false, 1], ['mine', 'a1', true, 1]])
    expect(got.cancelled.map((m) => m.meetingKey)).toEqual([meetingKey('calendar_event', 'cancelled')])
    expect([...got.declined]).toEqual([meetingKey('calendar_event', 'declined')])
    expect([...got.completeAccounts]).toEqual(['a1'])
  })

  it('an account read that failed, hit the cap, or lost its token is not complete', async () => {
    const failed = await readMeetingWindow(db as never, person, { fromMs: NOW, toMs: NOW + 60 * 60_000 }, { listAccount: async () => { throw new Error('provider down') } })
    expect(failed.completeAccounts.size).toBe(0)
    const full = Array.from({ length: MAX_EVENTS }, (_, i) => evt(`m${i}`, 10 + i))
    const capped = await readMeetingWindow(db as never, person, { fromMs: NOW, toMs: NOW + 24 * 60 * 60_000 }, { listAccount: reading(full) })
    expect(capped.completeAccounts.size).toBe(0)
    const gone = await readMeetingWindow(db as never, person, { fromMs: NOW, toMs: NOW + 60 * 60_000 }, { listAccount: vi.fn(async (): Promise<AccountRead> => 'no_token') })
    expect(gone.completeAccounts.size).toBe(0)
  })

  it('organizedBy: the event\'s organizer, or an attendee entry marked organizer, is the account\'s own address', () => {
    expect(organizedBy({ organizer: 'Me@Us.example ' }, 'me@us.example')).toBe(true)
    expect(organizedBy({ attendeeDetails: [{ email: 'me@us.example', isOrganizer: true }] }, 'me@us.example')).toBe(true)
    expect(organizedBy({ organizer: 'sam@them.example' }, 'me@us.example')).toBe(false)
    expect(organizedBy({ organizer: 'me@us.example' }, null)).toBe(false)
  })
})

describe('meetingAudiences', () => {
  const m = (id: string, attendees: string[], over: Partial<UpcomingMeeting> = {}): UpcomingMeeting => ({ ref: 'calendar_event', id, meetingKey: meetingKey('calendar_event', id), workspaceId: 'w1', userId: 'u1', title: id, startIso: inMin(60), attendees, calendarEventId: id, captureId: null, ...over })

  it('external: someone who is not the person, a member or a room; internal: only members besides the person; a solo block or a room has none', async () => {
    const meetings = [
      m('external', ['me@us.example', 'dana@acme.example', 'teammate@us.example']),
      m('internal', ['me@us.example', 'teammate@us.example']),
      m('room', ['me@us.example', 'c_188@resource.calendar.google.com']),
      m('solo', ['me@us.example']),
      m('nobody', []),
    ]
    const got = await meetingAudiences(db as never, person, meetings, { memberEmails: async () => new Set(['teammate@us.example']) })
    expect([...got]).toEqual([
      [meetingKey('calendar_event', 'external'), 'external'],
      [meetingKey('calendar_event', 'internal'), 'internal'],
    ])
  })

  it('a pending capture with no attendee list: external with a participant from outside, else internal (only meetings of two or more become one)', async () => {
    db.seed('capture_participant', [{ capture_id: 'cap-x', member_id: null, external_email: 'dana@acme.example' }])
    const bare = (id: string) => m(id, [], { ref: 'capture', meetingKey: meetingKey('capture', id), captureId: id, calendarEventId: null })
    const got = await meetingAudiences(db as never, person, [bare('cap-x'), bare('cap-team')], { memberEmails: async () => new Set() })
    expect(got.get(meetingKey('capture', 'cap-x'))).toBe('external')
    expect(got.get(meetingKey('capture', 'cap-team'))).toBe('internal')
  })

  it('keeps each calendar meeting\'s series identity (series key, iCalendar UID)', async () => {
    const listAccount = reading([evt('weekly_20261014T123000Z', 30, { seriesMasterId: 'weekly', icalUid: 'uid-1@google.com', hasRecurrence: true })])
    const [got] = await listUpcomingMeetings(db as never, person, { fromMs: NOW, toMs: NOW + 60 * 60_000 }, { listAccount })
    expect(got).toMatchObject({ seriesKey: 'weekly', icalUid: 'uid-1@google.com' })
  })
})

describe('prep, found by its key; meeting-soon rows', () => {
  it('a prep run is found by its idempotency key, for a desktop event too; ready once its work item is in review or done', async () => {
    const local = { meetingKey: meetingKey('local_calendar_event', 'local-1'), startIso: inMin(20) }
    const other = { meetingKey: meetingKey('calendar_event', 'b'), startIso: inMin(25) }
    db.seed('agent_run', [{ id: 'run-1', workspace_id: 'w1', status: 'running', fire_key: prepFireKey('home', local) }])
    db.seed('tracked_job', [{ id: 'job-1', agent_run_id: 'run-1', status: 'needs_review' }])
    const status = await prepStatusFor(db as never, person, [local, other])
    expect(status.get(local.meetingKey)).toEqual({ exists: true, ready: true, dead: false })
    expect(status.has(other.meetingKey)).toBe(false)
    expect(parsePrepFireKey(prepFireKey('home', local))).toEqual({ meetingKey: local.meetingKey, startMs: Date.parse(inMin(20)) })
  })

  it('meetings within 30 minutes with someone else in them; "prep ready" is its own dedupe key, so it lands when prep becomes ready', () => {
    const m = (id: string, startMin: number, attendees = ['me@us.example', 'x@y.example']): UpcomingMeeting => ({ ref: 'local_calendar_event', id, meetingKey: meetingKey('local_calendar_event', id), workspaceId: 'w1', userId: 'u1', title: `M ${id}`, startIso: inMin(startMin), attendees, calendarEventId: id, captureId: null })
    const prep = new Map([[meetingKey('local_calendar_event', 'ready'), { exists: true, ready: true, dead: false }]])
    const soon = meetingsStartingSoon([m('ready', 20), m('noprep', 25), m('far', 45), m('alone', 10, ['me@us.example'])], prep, NOW)
    expect(soon.map((c) => [c.id, c.prepReady])).toEqual([
      ['ready', true],
      ['noprep', false],
    ])
    const ready = meetingSoonEvent(soon[0])
    const noprep = meetingSoonEvent(soon[1])
    expect(ready).toMatchObject({ refType: 'local_calendar_event', refId: 'ready', facts: { prepReady: true, meetingRef: 'local_calendar_event', prepKey: soon[0].meetingKey } })
    expect(ready.dedupeKey).toBe(`meeting:${soon[0].meetingKey}:${inMin(20)}:prep`)
    expect(noprep.dedupeKey).toBe(`meeting:${soon[1].meetingKey}:${inMin(25)}`)
    // The router notifies the ready one; the other waits quietly.
    expect(routeEvent({ kind: 'meeting.soon', facts: ready.facts!, occurs_at: inMin(20), expires_at: inMin(20) }, { paused: false, dormant: false, overUsage: false }, NOW).outcome).toBe('notify')
  })
})

describe('meetingPassFor (one person, one calendar read)', () => {
  const rpc = vi.fn()
  const deps = (over: Partial<MeetingPassDeps> = {}): MeetingPassDeps => ({
    pausedState: async () => 'active',
    isDormant: async () => false,
    startHelper: async (_db, start) => {
      rpc(start)
      return { status: 'started', run_id: `run-${rpc.mock.calls.length}`, work_item_id: 'item', reused: false }
    },
    listAccount: reading([evt('soon', 20), evt('prep-me', 28), evt('internal', 25, { attendees: ['me@us.example', 'teammate@us.example'] }), evt('too-close', 4), evt('later', 60)]),
    memberEmails: async () => new Set(['teammate@us.example']),
    record: { send },
    // Jev's check says prep: these tests pin what happens after it (meeting-prep-check.test.ts pins the check).
    decidePrep: async () => ({ status: 'accepted', value: 'prep', inferenceId: 'inf', version: 'v' }),
    ...over,
  })

  beforeEach(() => rpc.mockClear())

  it('records meeting-soon rows and starts the first prep; the other candidates (internal ones too) wait for the next pass, one RPC per person per pass', async () => {
    const personTimeZone = vi.fn(async () => 'America/New_York')
    const out = await meetingPassFor(db as never, person, deps({ personTimeZone }), NOW)
    // `later` (60 min) is past the 30-minute read: its prep waits for its own T−30.
    expect(out).toMatchObject({ meetings: 4, soon: 1, recorded: 1 })
    // One heads-up per meeting: the three whose prep started or is deferred
    // wait for it (until 15 minutes before); the one too close for prep gets
    // its plain heads-up now.
    const soonRows = db.rows('agent_event').map((r) => r.dedupe_key)
    expect(soonRows).toEqual([agentEventKey.meetingSoon(meetingKey('calendar_event', 'too-close'), inMin(4))])
    // soon (20 min), internal (25 min, only a teammate) and prep-me (28 min) all qualify; one prep works at a time.
    expect(rpc).toHaveBeenCalledOnce()
    expect(rpc.mock.calls[0][0]).toMatchObject({ kind: 'meeting_prep', scope: 'meeting-prep', subject: meetingKey('calendar_event', 'soon'), conversationId: 'home', quiet: true, callId: `prep-${Date.parse(inMin(20))}` })
    expect(String(rpc.mock.calls[0][0].taskPrompt)).toContain("**Who's there**")
    expect(String(rpc.mock.calls[0][0].taskPrompt)).toContain('EDT')
    // The zone is read once per person per pass.
    expect(personTimeZone).toHaveBeenCalledOnce()
    expect(out.preps).toEqual([
      { status: 'started', runId: 'run-1', workItemId: 'item' },
      { status: 'skipped', reason: 'deferred' },
      { status: 'skipped', reason: 'deferred' },
    ])
  })

  it('the meeting-changes watch sees the whole day of the one read; prep and heads-ups only its next 30 minutes', async () => {
    const watchChanges = vi.fn(async () => 2)
    const out = await meetingPassFor(db as never, person, deps({ watchChanges: watchChanges as MeetingPassDeps['watchChanges'] }), NOW)
    expect(watchChanges).toHaveBeenCalledOnce()
    const [, who, window, opts, now] = watchChanges.mock.calls[0] as unknown as [unknown, typeof person, { meetings: UpcomingMeeting[] }, unknown, number]
    expect(who).toBe(person)
    expect(now).toBe(NOW)
    expect(opts).toEqual({ record: { send } })
    // `later` (60 min) is in the watch's read, not in the 30-minute steps.
    expect(window.meetings.map((m) => m.id)).toContain('later')
    expect(out).toMatchObject({ meetings: 4, changed: 2 })
  })

  it('paused or dormant: no read, so no watch either', async () => {
    const watchChanges = vi.fn(async () => 0)
    await meetingPassFor(db as never, person, deps({ isDormant: async () => true, watchChanges: watchChanges as MeetingPassDeps['watchChanges'] }), NOW)
    expect(watchChanges).not.toHaveBeenCalled()
  })

  it('a busy slot (SERVER_LIVE) stops the pass for that person too: one RPC, the rest deferred and coming', async () => {
    const startHelper = vi.fn(async () => ({ status: 'refused', code: 'SERVER_LIVE' }))
    const out = await meetingPassFor(db as never, person, deps({ startHelper: startHelper as MeetingPassDeps['startHelper'] }), NOW)
    expect(startHelper).toHaveBeenCalledOnce()
    expect(out.preps.map((p) => (p.status === 'skipped' ? `${p.reason}${p.code ? `:${p.code}` : ''}` : p.status))).toEqual(['refused:SERVER_LIVE', 'deferred', 'deferred'])
    // Every one is coming: no plain heads-up for them yet.
    expect(out).toMatchObject({ soon: 1 })
  })

  it('an internal meeting gets the lighter prep', async () => {
    await meetingPassFor(db as never, person, deps({ listAccount: reading([evt('internal', 25, { attendees: ['me@us.example', 'teammate@us.example'] })]) }), NOW)
    expect(String(rpc.mock.calls[0][0].taskPrompt)).toContain('internal meeting')
    expect(String(rpc.mock.calls[0][0].taskPrompt)).not.toContain("**Who's there**")
  })

  it('keeps the calendar end for the prep (its brief names it)', async () => {
    await meetingPassFor(db as never, person, deps({ listAccount: reading([evt('long', 20, { end: inMin(140) })]) }), NOW)
    expect(String(rpc.mock.calls[0][0].taskPrompt)).toContain(`(\`${inMin(140)}\`)`)
  })

  it('a solo calendar block gets no prep and no heads-up', async () => {
    const out = await meetingPassFor(db as never, person, deps({ listAccount: reading([evt('focus', 20, { attendees: ['me@us.example'] })]) }), NOW)
    expect(rpc).not.toHaveBeenCalled()
    expect(out).toMatchObject({ meetings: 1, soon: 0, preps: [] })
  })

  it('a meeting with a prep run already is not started again; a dormant or paused workspace (an unreadable switch included) reads no calendar and starts nothing', async () => {
    db.seed('agent_run', [{ id: 'run-x', workspace_id: 'w1', status: 'running', fire_key: prepFireKey('home', { meetingKey: meetingKey('calendar_event', 'prep-me'), startIso: inMin(28) }) }])
    await meetingPassFor(db as never, person, deps(), NOW)
    expect(rpc.mock.calls.map(([s]) => s.subject)).toEqual([meetingKey('calendar_event', 'soon')])

    rpc.mockClear()
    const listAccount = reading([evt('prep-me', 28)])
    expect(await meetingPassFor(db as never, person, deps({ isDormant: async () => true, listAccount }), NOW)).toMatchObject({ skipped: 'dormant' })
    for (const state of ['paused', 'unknown'] as const) {
      expect(await meetingPassFor(db as never, person, deps({ pausedState: async () => state, listAccount }), NOW)).toMatchObject({ skipped: 'paused', preps: [] })
    }
    expect(listAccount).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })

  /** A database with the table's defaults (a new row is `new`, undelivered). */
  const freshDb = () => {
    db = makeFakeSupabase({ defaults: { agent_event: { state: 'new', outcome: null, delivered_at: null } } })
    db.seed('connected_account', [{ id: 'a1', user_id: 'u1', workspace_id: 'w1', provider: 'google', capability: 'calendar', is_enabled: true, account_email: 'me@us.example' }])
  }

  it('one heads-up per meeting: a meeting whose prep is coming waits for it, then lands as "prep ready" only', async () => {
    freshDb()
    const key = meetingKey('calendar_event', 'soon')
    // The pass starts its prep: no heads-up yet.
    await meetingPassFor(db as never, person, deps({ listAccount: reading([evt('soon', 25)]) }), NOW)
    expect(rpc).toHaveBeenCalledOnce()
    expect(db.rows('agent_event')).toEqual([])
    // The prep finished meanwhile: the next pass writes the one "prep ready" row.
    db.seed('agent_run', [{ id: 'run-p', workspace_id: 'w1', status: 'succeeded', fire_key: prepFireKey('home', { meetingKey: key, startIso: inMin(25) }) }])
    db.seed('tracked_job', [{ id: 'job-p', agent_run_id: 'run-p', status: 'needs_review' }])
    await meetingPassFor(db as never, person, deps({ listAccount: reading([evt('soon', 25)]) }), NOW + 5 * 60_000)
    const rows = db.rows('agent_event')
    expect(rows.map((r) => r.dedupe_key)).toEqual([agentEventKey.meetingSoon(key, inMin(25), true)])
    expect(rows[0]).toMatchObject({ state: 'new', facts: expect.objectContaining({ prepReady: true }) })
  })

  it('a prep still working 15 minutes before: the plain heads-up goes out; "prep ready" lands when it finishes, the notified plain row kept as it was', async () => {
    freshDb()
    const key = meetingKey('calendar_event', 'slow')
    db.seed('agent_run', [{ id: 'run-s', workspace_id: 'w1', status: 'running', fire_key: prepFireKey('home', { meetingKey: key, startIso: inMin(30) }) }])
    const pass = (atMin: number) => meetingPassFor(db as never, person, deps({ listAccount: reading([evt('slow', 30)]) }), NOW + atMin * 60_000)
    await pass(10)
    expect(db.rows('agent_event')).toEqual([])
    await pass(15)
    expect(db.rows('agent_event').map((r) => [r.dedupe_key, (r.facts as { prepReady?: boolean }).prepReady])).toEqual([[agentEventKey.meetingSoon(key, inMin(30)), false]])
    // The router notified it.
    Object.assign(db.rows('agent_event')[0], { state: 'routed', outcome: 'notify' })
    db.seed('tracked_job', [{ id: 'job-s', agent_run_id: 'run-s', status: 'needs_review' }])
    await pass(20)
    const rows = db.rows('agent_event')
    expect(rows.map((r) => r.dedupe_key)).toEqual([agentEventKey.meetingSoon(key, inMin(30)), agentEventKey.meetingSoon(key, inMin(30), true)])
    expect(rows[0]).toMatchObject({ state: 'routed', outcome: 'notify' })
  })

  it('a plain row nobody was told about yet is retired when "prep ready" lands (said once)', async () => {
    freshDb()
    const key = meetingKey('calendar_event', 'slow')
    db.seed('agent_run', [{ id: 'run-s', workspace_id: 'w1', status: 'running', fire_key: prepFireKey('home', { meetingKey: key, startIso: inMin(30) }) }])
    const pass = (atMin: number) => meetingPassFor(db as never, person, deps({ listAccount: reading([evt('slow', 30)]) }), NOW + atMin * 60_000)
    await pass(15)
    db.seed('tracked_job', [{ id: 'job-s', agent_run_id: 'run-s', status: 'needs_review' }])
    await pass(16)
    const rows = db.rows('agent_event')
    expect(rows[0]).toMatchObject({ dedupe_key: agentEventKey.meetingSoon(key, inMin(30)), state: 'expired', outcome: 'ignore' })
    expect(rows[1]).toMatchObject({ dedupe_key: agentEventKey.meetingSoon(key, inMin(30), true), state: 'new' })
  })

  it('perWorkspace reads a gate once per workspace per pass', async () => {
    const read = vi.fn(async () => 'active' as const)
    const memo = perWorkspace(read)
    await memo(db as never, 'w1')
    await memo(db as never, 'w1')
    await memo(db as never, 'w2')
    expect(read).toHaveBeenCalledTimes(2)
  })
})

describe('recordPrepReadyForRun (the prep settling inside the window)', () => {
  it('a meeting prep that just became ready lands the "prep ready" row now, from the meeting\'s own row, and retires it', async () => {
    const key = meetingKey('calendar_event', 'evt-9')
    const start = inMin(20)
    db.seed('agent_run', [{ id: 'run-9', workspace_id: 'w1', triggered_by: 'u1', server_helper: 'meeting_prep', fire_key: prepFireKey('home', { meetingKey: key, startIso: start }) }])
    db.seed('agent_event', [
      { id: '1', workspace_id: 'w1', user_id: 'u1', kind: 'meeting.soon', dedupe_key: agentEventKey.meetingSoon(key, start), state: 'routed', outcome: 'quiet', ref_type: 'calendar_event', ref_id: 'evt-9', facts: { title: 'Acme renewal', prepReady: false, meetingRef: 'calendar_event', prepKey: key }, delivered_at: null },
    ])
    expect(await recordPrepReadyForRun(db as never, { workspaceId: 'w1', agentRunId: 'run-9', nowMs: NOW }, { send })).toBe(true)
    const rows = db.rows('agent_event')
    expect(rows[1]).toMatchObject({ kind: 'meeting.soon', dedupe_key: agentEventKey.meetingSoon(key, start, true), ref_id: 'evt-9', facts: { title: 'Acme renewal', prepReady: true, meetingRef: 'calendar_event', prepKey: key } })
    expect(rows[0]).toMatchObject({ state: 'expired' })
    // The router is woken for the person.
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ name: 'agent/event.created', data: expect.objectContaining({ userId: 'u1' }) }))
  })

  it('nothing for a run that is not a meeting prep, a meeting further out or started, or one with no row yet', async () => {
    const key = meetingKey('calendar_event', 'e')
    db.seed('agent_run', [
      { id: 'helper', workspace_id: 'w1', triggered_by: 'u1', server_helper: null, fire_key: 'chat-helper:x' },
      { id: 'far', workspace_id: 'w1', triggered_by: 'u1', server_helper: 'meeting_prep', fire_key: prepFireKey('home', { meetingKey: key, startIso: inMin(90) }) },
      { id: 'norow', workspace_id: 'w1', triggered_by: 'u1', server_helper: 'meeting_prep', fire_key: prepFireKey('home', { meetingKey: key, startIso: inMin(15) }) },
    ])
    for (const id of ['helper', 'far', 'norow', 'missing']) expect(await recordPrepReadyForRun(db as never, { workspaceId: 'w1', agentRunId: id, nowMs: NOW }, { send })).toBe(false)
    expect(db.rows('agent_event')).toHaveLength(0)
  })
})

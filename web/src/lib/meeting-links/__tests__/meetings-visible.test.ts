/**
 * Meetings the person can find (calls plan, phase 7 follow-up):
 *   - team chat's meetings section (./section.ts, ./mine.ts): a meeting shows
 *     from the moment it is made, used or not; live first, then upcoming by
 *     start, then unscheduled, then recently ended; an ended one drops out
 *     after a while unless its conversation has unread messages; one I was
 *     invited to shows; someone else's that I have nothing to do with does not;
 *   - its calendar event (./calendar-events.ts): written once to the calendar
 *     picked (else the default) with our link as its place and no provider
 *     video link; none with no calendar connected (the app's calendar shows it
 *     from the meeting); a failure never fails the meeting; a new link, a
 *     revoke, an end and a move change the event on the SAME calendar; a
 *     disconnected account is skipped quietly; a booking's meeting is never
 *     shown twice;
 *   - the dialog's calendar default (./calendar-pick.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'

vi.mock('server-only', () => ({}))

import { MEETING_RECENT_MS, meetingPhase, meetingSection, meetingWhen, type MyMeeting } from '../section'
import { listMyMeetings } from '../mine'
import { addMeetingToCalendar, changeMeeting, meetingCalendarChanged, meetingCalendarEvents, meetingIdOfEvent, joinLine } from '../calendar-events'
import { accountOfDefaultCalendar, defaultCalendarOf } from '../calendar-pick'
import { meetingToken } from '../link'

const NOW = Date.parse('2026-11-11T15:00:00.000Z')
const H = 3_600_000
const iso = (ms: number) => new Date(ms).toISOString()

function meeting(over: Partial<MyMeeting> = {}): MyMeeting {
  return {
    id: over.id ?? 'm',
    channel_id: over.channel_id ?? `ch-${over.id ?? 'm'}`,
    title: 'Design review',
    starts_at: null,
    ends_at: null,
    opens_at: iso(NOW - H),
    closes_at: iso(NOW + 30 * 24 * H),
    revoked_at: null,
    created_at: iso(NOW - H),
    host_member_id: 'me',
    is_host: true,
    live: false,
    url: 'https://app.example/m/AbCdEfGhIjKlMnOpQrStUvWxYz012345',
    ...over,
  }
}

describe('the meetings section', () => {
  it('a meeting just made and never used shows at once, as "Any time"', () => {
    const shown = meetingSection([meeting({ id: 'new', created_at: iso(NOW - 1000) })], NOW)
    expect(shown.map((m) => [m.id, m.phase])).toEqual([['new', 'anytime']])
    expect(meetingWhen(shown[0], NOW, 'UTC')).toBe('Any time')
  })

  it('live first, then upcoming by start, then unscheduled (newest first), then recently ended', () => {
    const items = [
      meeting({ id: 'anytime-old', created_at: iso(NOW - 5 * H) }),
      meeting({ id: 'later', starts_at: iso(NOW + 48 * H), ends_at: iso(NOW + 49 * H), opens_at: iso(NOW + 47 * H), closes_at: iso(NOW + 51 * H) }),
      meeting({ id: 'ended', starts_at: iso(NOW - 3 * H), ends_at: iso(NOW - 2 * H), opens_at: iso(NOW - 4 * H), closes_at: iso(NOW + 1000) }),
      meeting({ id: 'soon', starts_at: iso(NOW + H), ends_at: iso(NOW + 2 * H), opens_at: iso(NOW + 0.5 * H), closes_at: iso(NOW + 4 * H) }),
      meeting({ id: 'live', live: true, starts_at: iso(NOW + 48 * H), ends_at: iso(NOW + 49 * H) }),
      meeting({ id: 'anytime-new', created_at: iso(NOW - H) }),
    ]
    expect(meetingSection(items, NOW).map((m) => `${m.id}:${m.phase}`)).toEqual(['live:live', 'soon:upcoming', 'later:upcoming', 'anytime-new:anytime', 'anytime-old:anytime', 'ended:ended'])
  })

  it('an ended one (revoked, run out, past its end) drops out after a while, unless its conversation has unread messages', () => {
    const revokedLong = meeting({ id: 'revoked-long', revoked_at: iso(NOW - MEETING_RECENT_MS - 1000) })
    const revokedNow = meeting({ id: 'revoked-now', revoked_at: iso(NOW - 1000), url: null })
    const ranOut = meeting({ id: 'ran-out', closes_at: iso(NOW - MEETING_RECENT_MS - 1000) })
    const unreadOld = meeting({ id: 'unread-old', channel_id: 'ch-unread', revoked_at: iso(NOW - 2 * MEETING_RECENT_MS) })
    const shown = meetingSection([revokedLong, revokedNow, ranOut, unreadOld], NOW, (ch) => (ch === 'ch-unread' ? 2 : 0))
    expect(shown.map((m) => m.id).sort()).toEqual(['revoked-now', 'unread-old'])
    expect(meetingPhase(revokedNow, NOW).phase).toBe('ended')
    expect(meetingWhen({ phase: 'ended', starts_at: null }, NOW)).toBe('Ended')
  })

  it('nothing to show: an empty section', () => {
    expect(meetingSection([], NOW)).toEqual([])
  })

  it('says when in the viewer’s own zone', () => {
    const soon = { phase: 'upcoming' as const, starts_at: '2026-11-11T18:30:00.000Z' }
    expect(meetingWhen(soon, NOW, 'America/New_York')).toBe('Today 1:30 PM')
    expect(meetingWhen({ phase: 'upcoming', starts_at: '2026-11-12T18:30:00.000Z' }, NOW, 'America/New_York')).toBe('Tomorrow 1:30 PM')
    expect(meetingWhen({ phase: 'upcoming', starts_at: '2026-11-20T18:30:00.000Z' }, NOW, 'America/New_York')).toBe('Fri, Nov 20, 1:30 PM')
    expect(meetingWhen({ phase: 'live', starts_at: null }, NOW)).toBe('Live now')
  })
})

describe('the person’s meetings, read', () => {
  const WS = 'ws-1'
  const USER = 'user-me'
  let tables: Record<string, Array<Record<string, unknown>>>
  const row = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    workspace_id: WS,
    channel_id: `ch-${id}`,
    host_member_id: 'mem-me',
    title: `Meeting ${id}`,
    starts_at: null,
    ends_at: null,
    opens_at: iso(NOW - H),
    closes_at: iso(NOW + 24 * H),
    revoked_at: null,
    created_at: iso(NOW - H),
    token_nonce: `nonce-${id}-aaaaaaaaaaaaaaaaaaaa`,
    ...over,
  })
  beforeEach(() => {
    vi.stubEnv('MEETING_LINK_SECRET', 'mine-test-secret')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example')
    tables = {
      member: [{ id: 'mem-me', user_id: USER, workspace_id: WS }],
      meeting: [
        row('hosted'),
        row('invited', { host_member_id: 'mem-ana' }),
        row('others', { host_member_id: 'mem-ana' }),
        row('live'),
        row('revoked-long', { revoked_at: iso(NOW - 2 * MEETING_RECENT_MS) }),
        row('revoked-now', { revoked_at: iso(NOW - 1000) }),
        row('elsewhere', { workspace_id: 'ws-2' }),
      ],
      team_chat_member: ['hosted', 'invited', 'live', 'revoked-long', 'revoked-now', 'elsewhere'].map((id) => ({ channel_id: `ch-${id}`, member_id: 'mem-me' })),
      team_call: [{ channel_id: 'ch-live', status: 'live' }, { channel_id: 'ch-hosted', status: 'ended' }],
    }
  })
  afterEach(() => vi.unstubAllEnvs())

  it('my meetings (hosted, invited), with whether their call is live and their link; never someone else’s', async () => {
    const db = memoryDb(tables) as unknown as SupabaseClient
    const mine = await listMyMeetings(db, db, { workspaceId: WS, userId: USER, now: NOW })
    expect(mine.map((m) => m.id).sort()).toEqual(['hosted', 'invited', 'live', 'revoked-now'])
    const by = Object.fromEntries(mine.map((m) => [m.id, m]))
    expect(by.hosted).toMatchObject({ is_host: true, live: false, url: `https://app.example/m/${meetingToken('hosted', 'nonce-hosted-aaaaaaaaaaaaaaaaaaaa')}` })
    expect(by.invited.is_host).toBe(false)
    expect(by.live.live).toBe(true)
    expect(by['revoked-now'].url).toBeNull()
    expect(JSON.stringify(mine)).not.toContain('nonce-')
  })

  it('not a member of the workspace: none', async () => {
    const db = memoryDb(tables) as unknown as SupabaseClient
    expect(await listMyMeetings(db, db, { workspaceId: WS, userId: 'someone-else', now: NOW })).toEqual([])
  })
})

describe('a scheduled meeting on the host’s calendar', () => {
  const MEETING = { id: '11111111-1111-4111-8111-111111111111', title: 'Design review', startsAt: iso(NOW + 24 * H), endsAt: iso(NOW + 24.5 * H), url: 'https://app.example/m/AbCdEfGhIjKlMnOpQrStUvWxYz012345' }
  let tables: Record<string, Array<Record<string, unknown>>>
  const calendars = [
    { id: 'acct-google', provider: 'google' as const, label: 'ana@example.com' },
    { id: 'acct-outlook', provider: 'microsoft' as const, label: 'ana@work.example' },
  ]
  const deps = () => ({
    accounts: vi.fn(async () => calendars),
    createEvent: vi.fn(async () => ({ id: 'evt-1', title: '', start: '', end: '' }) as never),
    updateEvent: vi.fn(async () => ({}) as never),
    deleteEvent: vi.fn(async () => {}),
    now: () => NOW + 24.2 * H,
  })
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    tables = {
      meeting: [{ id: MEETING.id, channel_id: 'ch-1', host_member_id: 'mem-me', title: MEETING.title, starts_at: MEETING.startsAt, ends_at: MEETING.endsAt, revoked_at: null, booking_id: null, calendar_event_id: null, calendar_account_id: null }],
      member: [{ id: 'mem-me', user_id: 'user-me', workspace_id: 'ws-1' }],
      team_chat_channel: [{ id: 'ch-1', name: MEETING.title }],
    }
  })

  it('written once to the default calendar: our link its place and first line, no provider video link; the meeting keeps where', async () => {
    const d = deps()
    const out = await addMeetingToCalendar(memoryDb(tables) as unknown as SupabaseClient, { meeting: MEETING, userId: 'user-me', workspaceId: 'ws-1' }, d)
    expect(out).toEqual({ written: 'provider', accountId: 'acct-google', eventId: 'evt-1' })
    expect(d.createEvent).toHaveBeenCalledWith('user-me', { title: 'Design review', description: joinLine(MEETING.url), start: MEETING.startsAt, end: MEETING.endsAt, location: MEETING.url }, 'acct-google', { video: false, idempotencyKey: MEETING.id })
    expect(tables.meeting[0]).toMatchObject({ calendar_event_id: 'evt-1', calendar_account_id: 'acct-google' })
  })

  it('on the calendar the host picked; one that isn’t theirs (or isn’t writable) falls back to the default', async () => {
    const d = deps()
    await addMeetingToCalendar(memoryDb(tables) as unknown as SupabaseClient, { meeting: MEETING, userId: 'user-me', workspaceId: 'ws-1', accountId: 'acct-outlook' }, d)
    expect((d.createEvent.mock.calls[0] as unknown[])[2]).toBe('acct-outlook')
    const d2 = deps()
    await addMeetingToCalendar(memoryDb(tables) as unknown as SupabaseClient, { meeting: MEETING, userId: 'user-me', workspaceId: 'ws-1', accountId: 'acct-someone-elses' }, d2)
    expect((d2.createEvent.mock.calls[0] as unknown[])[2]).toBe('acct-google')
  })

  it('no calendar connected: no provider event (the app’s calendar shows it from the meeting)', async () => {
    const d = { ...deps(), accounts: vi.fn(async () => []) }
    expect(await addMeetingToCalendar(memoryDb(tables) as unknown as SupabaseClient, { meeting: MEETING, userId: 'user-me', workspaceId: 'ws-1' }, d)).toEqual({ written: 'app' })
    expect(d.createEvent).not.toHaveBeenCalled()
  })

  it('a calendar that fails never throws (the meeting stands)', async () => {
    const d = deps()
    d.createEvent.mockRejectedValueOnce(new Error('Google Calendar create error: 503'))
    expect(await addMeetingToCalendar(memoryDb(tables) as unknown as SupabaseClient, { meeting: MEETING, userId: 'user-me', workspaceId: 'ws-1' }, d)).toEqual({ written: 'failed' })
    const broken = { ...deps(), accounts: vi.fn(async () => Promise.reject(new Error('accounts down'))) }
    expect(await addMeetingToCalendar(memoryDb(tables) as unknown as SupabaseClient, { meeting: MEETING, userId: 'user-me', workspaceId: 'ws-1' }, broken)).toEqual({ written: 'failed' })
  })

  it('a new link, an end during it, a move and a revoke change the event on the SAME calendar', async () => {
    Object.assign(tables.meeting[0], { calendar_event_id: 'evt-1', calendar_account_id: 'acct-outlook' })
    const db = memoryDb(tables) as unknown as SupabaseClient
    const d = deps()
    const url = 'https://app.example/m/ZyXwVuTsRqPoNmLkJiHgFeDcBa987654'
    expect(await meetingCalendarChanged(db, MEETING.id, { kind: 'relinked', url }, d)).toBe('updated')
    expect(d.updateEvent).toHaveBeenLastCalledWith('user-me', 'evt-1', { location: url, description: joinLine(url) }, { accountId: 'acct-outlook' })
    expect(await meetingCalendarChanged(db, MEETING.id, { kind: 'ended' }, d)).toBe('updated')
    expect(d.updateEvent).toHaveBeenLastCalledWith('user-me', 'evt-1', { end: iso(NOW + 24.2 * H) }, { accountId: 'acct-outlook' })
    expect(await meetingCalendarChanged(db, MEETING.id, { kind: 'ended' }, { ...d, now: () => NOW })).toBe('unchanged')
    expect(await meetingCalendarChanged(db, MEETING.id, { kind: 'moved', startsAt: iso(NOW + 48 * H), endsAt: iso(NOW + 49 * H) }, d)).toBe('updated')
    expect(d.updateEvent).toHaveBeenLastCalledWith('user-me', 'evt-1', { start: iso(NOW + 48 * H), end: iso(NOW + 49 * H) }, { accountId: 'acct-outlook' })
    expect(await meetingCalendarChanged(db, MEETING.id, { kind: 'revoked' }, d)).toBe('deleted')
    expect(d.deleteEvent).toHaveBeenCalledWith('user-me', 'evt-1', { accountId: 'acct-outlook' })
    expect(tables.meeting[0].calendar_event_id).toBeNull()
  })

  it('its account disconnected since, or a provider that refuses: quietly nothing (never a throw)', async () => {
    Object.assign(tables.meeting[0], { calendar_event_id: 'evt-1', calendar_account_id: null })
    const d = deps()
    expect(await meetingCalendarChanged(memoryDb(tables) as unknown as SupabaseClient, MEETING.id, { kind: 'revoked' }, d)).toBe('skipped')
    expect(d.deleteEvent).not.toHaveBeenCalled()
    Object.assign(tables.meeting[0], { calendar_account_id: 'acct-google' })
    d.deleteEvent.mockRejectedValueOnce(new Error('No valid token for account'))
    expect(await meetingCalendarChanged(memoryDb(tables) as unknown as SupabaseClient, MEETING.id, { kind: 'revoked' }, d)).toBe('failed')
    tables.meeting[0].calendar_event_id = null
    expect(await meetingCalendarChanged(memoryDb(tables) as unknown as SupabaseClient, MEETING.id, { kind: 'revoked' }, d)).toBe('none')
  })

  it('moved or renamed from the app’s calendar: the meeting, its window and its conversation follow (the host only)', async () => {
    Object.assign(tables.meeting[0], { calendar_event_id: 'evt-1', calendar_account_id: 'acct-google' })
    const d = deps()
    const db = memoryDb(tables) as unknown as SupabaseClient
    expect(await changeMeeting(db, { meetingId: MEETING.id, userId: 'user-ana', startsAt: iso(NOW + 48 * H) }, d)).toMatchObject({ ok: false, status: 403 })
    const out = await changeMeeting(db, { meetingId: MEETING.id, userId: 'user-me', title: 'Design sync', startsAt: iso(NOW + 48 * H) }, d)
    expect(out).toEqual({ ok: true, title: 'Design sync', startsAt: iso(NOW + 48 * H), endsAt: iso(NOW + 48.5 * H) })
    expect(tables.meeting[0]).toMatchObject({ title: 'Design sync', starts_at: iso(NOW + 48 * H), ends_at: iso(NOW + 48.5 * H), opens_at: iso(NOW + 47.75 * H), closes_at: iso(NOW + 50.5 * H) })
    expect(tables.team_chat_channel[0].name).toBe('Design sync')
    expect(d.updateEvent).toHaveBeenCalledWith('user-me', 'evt-1', { title: 'Design sync', start: iso(NOW + 48 * H), end: iso(NOW + 48.5 * H) }, { accountId: 'acct-google' })
    tables.meeting[0].booking_id = 'booking-1'
    expect(await changeMeeting(db, { meetingId: MEETING.id, userId: 'user-me', startsAt: iso(NOW + 72 * H) }, d)).toMatchObject({ ok: false, status: 400 })
  })
})

describe('the app’s calendar shows a host’s scheduled meetings that no provider event stands for', () => {
  beforeEach(() => {
    vi.stubEnv('MEETING_LINK_SECRET', 'cal-test-secret')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example')
  })
  afterEach(() => vi.unstubAllEnvs())

  it('only theirs, scheduled, live, without an event of its own, never a booking’s (no doubles); Join comes from its link', async () => {
    const base = { host_member_id: 'mem-me', starts_at: iso(NOW + 24 * H), ends_at: iso(NOW + 25 * H), revoked_at: null, booking_id: null, calendar_event_id: null, token_nonce: 'nonce-aaaaaaaaaaaaaaaaaaaaaaaaaa' }
    const tables = {
      member: [{ id: 'mem-me', user_id: 'user-me', workspace_id: 'ws-1' }],
      meeting: [
        { ...base, id: '11111111-1111-4111-8111-111111111111', title: 'Shown' },
        { ...base, id: '22222222-2222-4222-8222-222222222222', title: 'Unscheduled', starts_at: null, ends_at: null },
        { ...base, id: '33333333-3333-4333-8333-333333333333', title: 'A booking’s', booking_id: 'b-1' },
        { ...base, id: '44444444-4444-4444-8444-444444444444', title: 'On Google already', calendar_event_id: 'evt-9' },
        { ...base, id: '55555555-5555-4555-8555-555555555555', title: 'Revoked', revoked_at: iso(NOW) },
        { ...base, id: '66666666-6666-4666-8666-666666666666', title: 'Ana’s', host_member_id: 'mem-ana' },
        { ...base, id: '77777777-7777-4777-8777-777777777777', title: 'Next month', starts_at: iso(NOW + 40 * 24 * H), ends_at: iso(NOW + 40 * 24 * H + H) },
      ],
    }
    const events = await meetingCalendarEvents(memoryDb(tables) as unknown as SupabaseClient, 'user-me', { timeMin: iso(NOW), timeMax: iso(NOW + 7 * 24 * H), workspaceId: 'ws-1' })
    expect(events.map((e) => e.title)).toEqual(['Shown'])
    const url = `https://app.example/m/${meetingToken('11111111-1111-4111-8111-111111111111', 'nonce-aaaaaaaaaaaaaaaaaaaaaaaaaa')}`
    expect(events[0]).toMatchObject({ id: 'meeting:11111111-1111-4111-8111-111111111111', location: url, conferenceUrl: url, source: 'meeting_link', description: joinLine(url) })
    expect(meetingIdOfEvent(events[0].id)).toBe('11111111-1111-4111-8111-111111111111')
    expect(meetingIdOfEvent('evt-9')).toBeNull()
  })
})

describe('the dialog’s calendar default', () => {
  it('the last choice for meeting links, else the app’s default for new events, else the first (the primary)', () => {
    const ids = ['acct-google', '99999999-9999-4999-8999-999999999999']
    expect(defaultCalendarOf(ids, 'acct-google', null)).toBe('acct-google')
    expect(defaultCalendarOf(ids, 'acct-gone', 'oauth:99999999-9999-4999-8999-999999999999:primary')).toBe('99999999-9999-4999-8999-999999999999')
    expect(defaultCalendarOf(ids, null, null)).toBe('acct-google')
    expect(defaultCalendarOf([], 'acct-google', null)).toBeNull()
    expect(accountOfDefaultCalendar('local:abc')).toBeNull()
  })
})

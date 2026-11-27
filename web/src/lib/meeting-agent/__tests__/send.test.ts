import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))

const { cancelAttendance, sendAgentToMeeting, MEETING_CANCELLED_EVENT, MEETING_SCHEDULED_EVENT } = await import('@/lib/meeting-agent/send')
const { attendanceRow, fakeDb, ATT, EVENT, START, END, ME, WS } = await import('./fake-db')

const ON = { MEETING_AGENT: 'on' }
const NOW = new Date('2026-11-29T12:00:00.000Z')
const INPUT = {
  workspaceId: WS,
  userId: ME,
  calendarEventId: EVENT,
  startsAt: START,
  endsAt: END,
  title: 'Pilot  review',
  dialIn: { number: '+1 (555) 555-0142', digits: 'wwwwww123456789#' },
  brief: { goals: ['Get a yes'], ask: ['Who signs off?'] },
}

function deps(over: Record<string, unknown> = {}) {
  return { env: ON, now: () => NOW, displayName: vi.fn(async () => 'Sam Rivera'), send: vi.fn(async () => {}), ...over }
}

describe('sending the agent to a meeting', () => {
  it("writes it scheduled under the person's assistant name, with the approved brief, and asks the scheduler to dial", async () => {
    const db = fakeDb()
    const d = deps()
    const r = await sendAgentToMeeting(db.client, INPUT, d)
    expect(r.ok).toBe(true)
    const row = db.tables.meeting_attendance[0]
    expect(row).toMatchObject({ status: 'scheduled', display_name: "Sam's assistant (AI)", owner_first_name: 'Sam', dial_in_number: '+15555550142', dial_in_pin: 'wwwwww123456789#', title: 'Pilot review', brief_approved_at: NOW.toISOString() })
    expect(row.brief).toEqual({ goals: ['Get a yes'], may_share: [], ask: ['Who signs off?'], must_not_agree: [] })
    expect(d.send).toHaveBeenCalledWith({ name: MEETING_SCHEDULED_EVENT, data: { attendanceId: row.id, startsAt: START }, id: `meeting-dial:${row.id}:${START}` })
  })

  it('is off unless MEETING_AGENT is on', async () => {
    const db = fakeDb()
    expect(await sendAgentToMeeting(db.client, INPUT, deps({ env: {} }))).toMatchObject({ ok: false, reason: 'off' })
    expect(db.tables.meeting_attendance).toHaveLength(0)
  })

  it('refuses a meeting that is over, one with no US/CA dial-in, an unusable or empty brief, and a person with no name', async () => {
    const db = fakeDb()
    expect(await sendAgentToMeeting(db.client, { ...INPUT, endsAt: '2026-11-29T11:00:00.000Z' }, deps())).toMatchObject({ reason: 'over' })
    expect(await sendAgentToMeeting(db.client, { ...INPUT, dialIn: null }, deps())).toMatchObject({ reason: 'no_dial_in' })
    expect(await sendAgentToMeeting(db.client, { ...INPUT, dialIn: { number: '+44 20 7946 0958', digits: 'ww1#' } }, deps())).toMatchObject({ reason: 'no_dial_in' })
    expect(await sendAgentToMeeting(db.client, { ...INPUT, dialIn: { number: '+15555550142', digits: '1; drop' } }, deps())).toMatchObject({ reason: 'no_dial_in' })
    expect(await sendAgentToMeeting(db.client, { ...INPUT, brief: { goals: 'yes' } }, deps())).toMatchObject({ reason: 'bad_brief' })
    expect(await sendAgentToMeeting(db.client, { ...INPUT, brief: { may_share: ['x'] } }, deps())).toMatchObject({ reason: 'empty_brief' })
    expect(await sendAgentToMeeting(db.client, INPUT, deps({ displayName: vi.fn(async () => null) }))).toMatchObject({ reason: 'no_name' })
    expect(db.tables.meeting_attendance).toHaveLength(0)
  })

  it('sends again over a cancelled one, but never over one already in the meeting', async () => {
    const db = fakeDb({ meeting_attendance: [attendanceRow({ status: 'cancelled' })] })
    expect((await sendAgentToMeeting(db.client, INPUT, deps())).ok).toBe(true)
    expect(db.tables.meeting_attendance).toHaveLength(1)
    expect(db.tables.meeting_attendance[0].status).toBe('scheduled')
    db.tables.meeting_attendance[0].status = 'in_meeting'
    expect(await sendAgentToMeeting(db.client, INPUT, deps())).toMatchObject({ ok: false, reason: 'busy' })
  })
})

describe('calling it off', () => {
  it('before the call: cancelled, and the scheduled dial is cancelled too', async () => {
    const db = fakeDb({ meeting_attendance: [attendanceRow()] })
    const send = vi.fn(async () => {})
    expect(await cancelAttendance(db.client, { workspaceId: WS, userId: ME, id: ATT }, { send })).toBe('cancelled')
    expect(db.tables.meeting_attendance[0]).toMatchObject({ status: 'cancelled', status_detail: 'by_person' })
    expect(send).toHaveBeenCalledWith({ name: MEETING_CANCELLED_EVENT, data: { attendanceId: ATT } })
  })
  it('during it: hangs up the session and the Twilio leg (the bridge then finishes the notes)', async () => {
    const db = fakeDb({ meeting_attendance: [attendanceRow({ status: 'in_meeting', live_session_id: 'live_1', twilio_call_sid: 'CA1' })] })
    vi.stubEnv('GPT_LIVE_API_KEY', 'sk-test')
    const hangUp = vi.fn(async () => {})
    const endTwilioCall = vi.fn(async () => {})
    expect(await cancelAttendance(db.client, { workspaceId: WS, userId: ME, id: ATT }, { hangUp, endTwilioCall })).toBe('pulled_out')
    vi.unstubAllEnvs()
    expect(hangUp).toHaveBeenCalledWith('live_1')
    expect(endTwilioCall).toHaveBeenCalledWith('CA1')
    expect(db.tables.meeting_attendance[0].status).toBe('in_meeting')
  })
  it("someone else's, or one that's over, is left alone", async () => {
    const db = fakeDb({ meeting_attendance: [attendanceRow({ status: 'ended' })] })
    expect(await cancelAttendance(db.client, { workspaceId: WS, userId: 'user-other', id: ATT })).toBe('not_found')
    expect(await cancelAttendance(db.client, { workspaceId: WS, userId: ME, id: ATT })).toBe('over')
  })
})

describe('checking a send without writing (the brief editor\'s Review)', () => {
  it('passes what a send would send, and writes nothing', async () => {
    const { checkSend } = await import('@/lib/meeting-agent/send')
    const db = fakeDb()
    const d = deps()
    const r = await checkSend(db.client, INPUT, d)
    expect(r).toEqual({ ok: true, checked: { eventId: EVENT, startsAt: START, endsAt: END, number: '+15555550142', digits: 'wwwwww123456789#', brief: { goals: ['Get a yes'], may_share: [], ask: ['Who signs off?'], must_not_agree: [] }, firstName: 'Sam' } })
    expect(db.tables.meeting_attendance).toHaveLength(0)
    expect(d.send).not.toHaveBeenCalled()
  })
  it('refuses exactly what a send refuses', async () => {
    const { checkSend } = await import('@/lib/meeting-agent/send')
    expect(await checkSend(fakeDb().client, { ...INPUT, dialIn: null }, deps())).toMatchObject({ ok: false, reason: 'no_dial_in' })
    expect(await checkSend(fakeDb().client, INPUT, deps({ env: {} }))).toMatchObject({ ok: false, reason: 'off' })
  })
})

import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))

const { finishMeeting, MEETING_NOTES_READY_EVENT, MEETING_AGENT_CAPTURE_SOURCE } = await import('@/lib/meeting-agent/finish')
const { MeetingNotes } = await import('@/lib/meeting-agent/notes')
const { attendanceOfRow } = await import('@/lib/meeting-agent/store')
const { attendanceRow, fakeDb, ATT, EVENT, START, ME, WS } = await import('./fake-db')

const NOW = new Date('2026-11-30T18:40:00.000Z')

function notesWith(words: string | null) {
  const n = new MeetingNotes("Sam's assistant (AI)")
  if (words) n.add('meeting', words, 0, 1000)
  return n
}

describe('the end of an attended meeting', () => {
  it('writes a new capture linked to the meeting, closes the attendance, and queues the finishing pass', async () => {
    const db = fakeDb({ meeting_attendance: [attendanceRow({ status: 'in_meeting', joined_at: START })] })
    const a = attendanceOfRow(db.tables.meeting_attendance[0] as never)
    const send = vi.fn(async () => {})
    const out = await finishMeeting(db.client, { attendance: a, notes: notesWith('We agreed to a pilot.'), end: 'ended' }, { send, now: () => NOW })
    const cap = db.tables.captures[0]
    expect(out.captureId).toBe(cap.id)
    expect(cap).toMatchObject({ user_id: ME, workspace_id: WS, calendar_event_id: EVENT, title: 'Pilot review with Acme', is_transcript_locked: true, metadata: { source: MEETING_AGENT_CAPTURE_SOURCE, meeting_attendance_id: ATT } })
    expect(String(cap.transcript)).toContain("taken by Sam's AI assistant")
    expect(String(cap.transcript)).toContain('[Meeting] We agreed to a pilot.')
    expect(db.tables.meeting_attendance[0]).toMatchObject({ status: 'ended', capture_id: cap.id, left_at: NOW.toISOString() })
    expect(send).toHaveBeenCalledWith({ name: MEETING_NOTES_READY_EVENT, data: { attendanceId: ATT, captureId: cap.id, workspaceId: WS, userId: ME }, id: `meeting-notes:${ATT}` })
  })

  it("fills the person's own pending capture of the occurrence when one waits with no words", async () => {
    const pending = { id: 'cap-pending', workspace_id: WS, user_id: ME, calendar_event_id: EVENT, scheduled_start: START, ended_at: null, status: 'active', transcript: null, metadata: { from: 'sync' } }
    const db = fakeDb({ meeting_attendance: [attendanceRow({ status: 'in_meeting' })], captures: [pending] })
    const a = attendanceOfRow(db.tables.meeting_attendance[0] as never)
    const out = await finishMeeting(db.client, { attendance: a, notes: notesWith('Hello.'), end: 'ended' }, { send: vi.fn(async () => {}), now: () => NOW })
    expect(out.captureId).toBe('cap-pending')
    expect(db.tables.captures).toHaveLength(1)
    expect(db.tables.captures[0]).toMatchObject({ is_transcript_locked: true, metadata: { from: 'sync', source: MEETING_AGENT_CAPTURE_SOURCE } })
  })

  it('an objection ends it as objected, the notes say so', async () => {
    const db = fakeDb({ meeting_attendance: [attendanceRow({ status: 'in_meeting' })] })
    const a = attendanceOfRow(db.tables.meeting_attendance[0] as never)
    await finishMeeting(db.client, { attendance: a, notes: notesWith('No recording please.'), end: 'objected' }, { send: vi.fn(async () => {}), now: () => NOW })
    expect(db.tables.meeting_attendance[0].status).toBe('objected')
    expect(String(db.tables.captures[0].transcript)).toContain('Someone objected')
  })

  it('a meeting where nobody spoke leaves no capture and queues nothing', async () => {
    const db = fakeDb({ meeting_attendance: [attendanceRow({ status: 'in_meeting' })] })
    const a = attendanceOfRow(db.tables.meeting_attendance[0] as never)
    const send = vi.fn()
    expect(await finishMeeting(db.client, { attendance: a, notes: notesWith(null), end: 'ended' }, { send, now: () => NOW })).toEqual({ captureId: null })
    expect(db.tables.captures).toHaveLength(0)
    expect(db.tables.meeting_attendance[0]).toMatchObject({ status: 'ended', status_detail: 'nothing_said' })
    expect(send).not.toHaveBeenCalled()
  })

  it('a failed notes write still closes the attendance, and never throws', async () => {
    const db = fakeDb({ meeting_attendance: [attendanceRow({ status: 'in_meeting' })] }, { failOn: 'insert' })
    const a = attendanceOfRow(db.tables.meeting_attendance[0] as never)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await finishMeeting(db.client, { attendance: a, notes: notesWith('x'), end: 'cut' }, { send: vi.fn(), now: () => NOW })).toEqual({ captureId: null })
    expect(db.tables.meeting_attendance[0]).toMatchObject({ status: 'ended', status_detail: 'notes_failed' })
    err.mockRestore()
  })
})

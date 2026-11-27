import { describe, expect, it } from 'vitest'
import { handleMeetingCallStatus } from '@/lib/meeting-agent/call-status'
import { claimByJoinToken } from '@/lib/meeting-agent/store'
import { hashJoinToken, newJoinToken } from '@/lib/meeting-agent/dial-out'
import { attendanceRow, fakeDb, ATT } from './fake-db'

describe("Twilio's word on the outbound leg", () => {
  it('busy, no answer or failed: the attendance fails with the reason', async () => {
    const db = fakeDb({ meeting_attendance: [attendanceRow({ status: 'dialling', twilio_call_sid: 'CA1', join_token_hash: 'h' })] })
    expect(await handleMeetingCallStatus(db.client, { attendanceId: ATT, callSid: 'CA1', status: 'no-answer' })).toBe('failed')
    expect(db.tables.meeting_attendance[0]).toMatchObject({ status: 'failed', status_detail: 'call_no_answer', join_token_hash: null })
  })
  it('ended while still dialling (never let in, a wrong PIN): failed, not_let_in', async () => {
    const db = fakeDb({ meeting_attendance: [attendanceRow({ status: 'dialling', twilio_call_sid: 'CA1' })] })
    expect(await handleMeetingCallStatus(db.client, { attendanceId: ATT, callSid: 'CA1', status: 'completed' })).toBe('not_let_in')
    expect(db.tables.meeting_attendance[0].status_detail).toBe('not_let_in')
  })
  it('ended while in the meeting: left to the bridge; another call sid: unknown', async () => {
    const db = fakeDb({ meeting_attendance: [attendanceRow({ status: 'in_meeting', twilio_call_sid: 'CA1' })] })
    expect(await handleMeetingCallStatus(db.client, { attendanceId: ATT, callSid: 'CA1', status: 'completed' })).toBe('ignored')
    expect(await handleMeetingCallStatus(db.client, { attendanceId: ATT, callSid: 'CA2', status: 'failed' })).toBe('unknown')
    expect(db.tables.meeting_attendance[0].status).toBe('in_meeting')
  })
})

describe("the webhook's token claim", () => {
  it('matches the dialling attendance by hash once, then never again', async () => {
    const { token, hash } = newJoinToken()
    const db = fakeDb({ meeting_attendance: [attendanceRow({ status: 'dialling', join_token_hash: hash })] })
    const first = await claimByJoinToken(db.client, hashJoinToken(token), 'live_1')
    expect(first).toMatchObject({ id: ATT, status: 'in_meeting', liveSessionId: 'live_1' })
    expect(db.tables.meeting_attendance[0].join_token_hash).toBeNull()
    expect(await claimByJoinToken(db.client, hashJoinToken(token), 'live_2')).toBeNull()
  })
  it('a token for an attendance that is not dialling matches nothing', async () => {
    const { hash } = newJoinToken()
    const db = fakeDb({ meeting_attendance: [attendanceRow({ status: 'scheduled', join_token_hash: hash })] })
    expect(await claimByJoinToken(db.client, hash, 'live_1')).toBeNull()
  })
})

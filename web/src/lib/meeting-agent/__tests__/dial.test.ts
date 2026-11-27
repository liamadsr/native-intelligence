import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dialAttendance, LATE_DIAL_MAX_MS } from '@/lib/meeting-agent/dial'
import { hashJoinToken } from '@/lib/meeting-agent/dial-out'
import { attendanceRow, fakeDb, ATT, START, END } from './fake-db'

const ENV = { MEETING_AGENT: 'on', MEETING_AGENT_SIP_URI: 'sip:proj_test@sip.api.openai.com;transport=tls', GPT_LIVE_TRUNK_SECRET: 'ab'.repeat(32), MEETING_AGENT_MAX_MINUTES: '45' }
const NOW = Date.parse(START) - 60_000

beforeEach(() => {
  vi.stubEnv('TWILIO_ACCOUNT_SID', 'AC123')
  vi.stubEnv('TWILIO_AUTH_TOKEN', 'tok')
  vi.stubEnv('TWILIO_PHONE_NUMBER', '+15555550100')
  vi.stubEnv('TWILIO_MESSAGING_SERVICE_SID', '')
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.com')
})
afterEach(() => vi.unstubAllEnvs())

describe('dialling a meeting at its start', () => {
  it("moves it to dialling with only the token's hash kept, and calls the meeting with the PIN and the bridge", async () => {
    const db = fakeDb({ meeting_attendance: [attendanceRow()] })
    const dial = vi.fn(async () => ({ ok: true as const, callSid: 'CA9' }))
    expect(await dialAttendance(db.client, { attendanceId: ATT, startsAt: START }, { env: ENV, now: () => NOW, dial })).toBe('dialling')
    const row = db.tables.meeting_attendance[0]
    expect(row).toMatchObject({ status: 'dialling', twilio_call_sid: 'CA9' })
    const [config, args] = dial.mock.calls[0] as unknown as [Record<string, string>, Record<string, unknown>]
    expect(config.accountSid).toBe('AC123')
    expect(args).toMatchObject({ from: '+15555550100', to: '+15555550142', timeLimitSeconds: 45 * 60, statusCallback: `https://app.example.com/api/calls/meeting/status?attendance=${ATT}` })
    const twiml = String(args.twiml)
    expect(twiml).toContain('<Play digits="wwwwww123456789#"/>')
    const token = /X-NI-Meeting=([0-9a-f]{64})/.exec(twiml)![1]
    expect(row.join_token_hash).toBe(hashJoinToken(token))
    expect(JSON.stringify(row)).not.toContain(token)
  })

  it('does nothing when the server has it off, and fails it (never dials) when the calls are not set up', async () => {
    const db = fakeDb({ meeting_attendance: [attendanceRow()] })
    const dial = vi.fn()
    expect(await dialAttendance(db.client, { attendanceId: ATT, startsAt: START }, { env: { ...ENV, MEETING_AGENT: '' }, now: () => NOW, dial })).toBe('off')
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await dialAttendance(db.client, { attendanceId: ATT, startsAt: START }, { env: { ...ENV, MEETING_AGENT_SIP_URI: '' }, now: () => NOW, dial })).toBe('not_configured')
    err.mockRestore()
    expect(db.tables.meeting_attendance[0]).toMatchObject({ status: 'failed', status_detail: 'not_configured' })
    expect(dial).not.toHaveBeenCalled()
  })

  it('a cancelled, moved, or ended meeting is not dialled', async () => {
    const dial = vi.fn()
    const cancelled = fakeDb({ meeting_attendance: [attendanceRow({ status: 'cancelled' })] })
    expect(await dialAttendance(cancelled.client, { attendanceId: ATT, startsAt: START }, { env: ENV, now: () => NOW, dial })).toBe('not_scheduled')
    const moved = fakeDb({ meeting_attendance: [attendanceRow({ starts_at: '2026-11-30T19:00:00.000Z' })] })
    expect(await dialAttendance(moved.client, { attendanceId: ATT, startsAt: START }, { env: ENV, now: () => NOW, dial })).toBe('moved')
    const over = fakeDb({ meeting_attendance: [attendanceRow()] })
    expect(await dialAttendance(over.client, { attendanceId: ATT, startsAt: START }, { env: ENV, now: () => Date.parse(END), dial })).toBe('over')
    expect(over.tables.meeting_attendance[0]).toMatchObject({ status: 'failed', status_detail: 'meeting_over' })
    const noEnd = fakeDb({ meeting_attendance: [attendanceRow({ ends_at: null })] })
    expect(await dialAttendance(noEnd.client, { attendanceId: ATT, startsAt: START }, { env: ENV, now: () => Date.parse(START) + LATE_DIAL_MAX_MS, dial })).toBe('over')
    expect(await dialAttendance(fakeDb().client, { attendanceId: ATT, startsAt: START }, { env: ENV, now: () => NOW, dial })).toBe('gone')
    expect(dial).not.toHaveBeenCalled()
  })

  it('a row whose digits are not DTMF is never dialled', async () => {
    const db = fakeDb({ meeting_attendance: [attendanceRow({ dial_in_pin: '1;2' })] })
    const dial = vi.fn()
    expect(await dialAttendance(db.client, { attendanceId: ATT, startsAt: START }, { env: ENV, now: () => NOW, dial })).toBe('not_ready')
    expect(dial).not.toHaveBeenCalled()
  })

  it('a refused call fails it with the reason, its token gone', async () => {
    const db = fakeDb({ meeting_attendance: [attendanceRow()] })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await dialAttendance(db.client, { attendanceId: ATT, startsAt: START }, { env: ENV, now: () => NOW, dial: vi.fn(async () => ({ ok: false as const, status: 400, code: '21215' })) })).toBe('refused')
    warn.mockRestore()
    expect(db.tables.meeting_attendance[0]).toMatchObject({ status: 'failed', status_detail: 'dial_refused:21215', join_token_hash: null })
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  found: null as null | { event: Record<string, unknown>; dialIn: unknown },
  sends: [] as Array<Record<string, unknown>>,
  sendResult: null as null | Record<string, unknown>,
  cancels: [] as Array<Record<string, unknown>>,
  rows: [] as Array<Record<string, unknown>>,
}))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: async () => ({ supabase: {}, user: { id: 'user-me' }, workspaceId: 'ws-1' }) }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/meeting-agent/lookup', () => ({ findMeeting: async () => h.found }))
vi.mock('@/lib/meeting-agent/send', () => ({
  sendAgentToMeeting: async (_s: unknown, input: Record<string, unknown>) => (h.sends.push(input), h.sendResult),
  cancelAttendance: async (_s: unknown, scope: Record<string, unknown>) => (h.cancels.push(scope), 'cancelled'),
}))
vi.mock('@/lib/meeting-agent/store', async (orig) => ({ ...(await orig<typeof import('@/lib/meeting-agent/store')>()), listAttendances: async () => h.rows }))

import { NextRequest } from 'next/server'
import { DELETE, GET, POST } from '../route'
import { attendanceOfRow } from '@/lib/meeting-agent/store'
import { attendanceRow } from '@/lib/meeting-agent/__tests__/fake-db'

const START = '2026-11-30T18:00:00.000Z'
const req = (method: string, body?: unknown, qs = '') => new NextRequest(`https://app.example.com/api/account/meeting-agent${qs}`, { method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) })

beforeEach(() => {
  vi.stubEnv('MEETING_AGENT', 'on')
  h.found = { event: { id: 'evt_1', title: 'Pilot review', start: START, end: '2026-11-30T18:30:00.000Z' }, dialIn: { number: '+15555550142', digits: 'wwwwww1#', platform: 'meet' } }
  h.sends = []
  h.cancels = []
  h.sendResult = { ok: true, attendance: attendanceOfRow(attendanceRow() as never) }
  h.rows = [attendanceOfRow(attendanceRow() as never) as never]
})
afterEach(() => vi.unstubAllEnvs())

describe('/api/account/meeting-agent', () => {
  it('is off (403) unless MEETING_AGENT is on', async () => {
    vi.stubEnv('MEETING_AGENT', '')
    expect((await GET()).status).toBe(403)
    expect((await POST(req('POST', {}))).status).toBe(403)
    expect((await DELETE(req('DELETE', undefined, '?id=x'))).status).toBe(403)
  })
  it('lists theirs, never with the PIN', async () => {
    const body = await (await GET()).json()
    expect(body.attendances[0]).toMatchObject({ status: 'scheduled', hasPin: true, displayName: "Sam's assistant (AI)" })
    expect(JSON.stringify(body)).not.toContain('123456789')
  })
  it('sends to a meeting on their calendar, with its dial-in from the invite', async () => {
    const res = await POST(req('POST', { calendar_event_id: 'evt_1', starts_at: START, brief: { goals: ['A yes'] } }))
    expect(res.status).toBe(200)
    expect(h.sends[0]).toMatchObject({ workspaceId: 'ws-1', userId: 'user-me', calendarEventId: 'evt_1', title: 'Pilot review', dialIn: h.found!.dialIn, brief: { goals: ['A yes'] } })
    expect(JSON.stringify(await res.json())).not.toContain('123456789')
  })
  it("refuses a meeting that isn't on their calendar, and passes on a refusal", async () => {
    h.found = null
    expect((await POST(req('POST', { calendar_event_id: 'evt_1', starts_at: START, brief: {} }))).status).toBe(404)
    h.found = { event: { title: 'x', start: START, end: '' }, dialIn: null }
    h.sendResult = { ok: false, reason: 'no_dial_in', message: 'No dial-in.' }
    const res = await POST(req('POST', { calendar_event_id: 'evt_1', starts_at: START, brief: {} }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'NO_DIAL_IN' })
    h.sendResult = { ok: false, reason: 'busy', message: 'Already there.' }
    expect((await POST(req('POST', { calendar_event_id: 'evt_1', starts_at: START, brief: {} }))).status).toBe(409)
  })
  it('calls one off by id', async () => {
    const id = '22222222-2222-4222-8222-222222222222'
    expect(await (await DELETE(req('DELETE', undefined, `?id=${id}`))).json()).toEqual({ outcome: 'cancelled' })
    expect(h.cancels).toEqual([{ workspaceId: 'ws-1', userId: 'user-me', id }])
    expect((await DELETE(req('DELETE', undefined, '?id=nope'))).status).toBe(400)
  })
})

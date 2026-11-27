import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  found: null as null | { event: Record<string, unknown>; dialIn: unknown },
  sends: [] as Array<Record<string, unknown>>,
  sendResult: null as null | Record<string, unknown>,
  cancels: [] as Array<Record<string, unknown>>,
  rows: [] as Array<Record<string, unknown>>,
  saved: [] as Array<Record<string, unknown>>,
  paused: [] as Array<unknown>,
  removed: [] as Array<unknown>,
}))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: async () => ({ supabase: {}, user: { id: 'user-me' }, workspaceId: 'ws-1' }) }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/meeting-agent/lookup', () => ({ findMeeting: async () => h.found }))
vi.mock('@/lib/meeting-agent/send', () => ({
  sendAgentToMeeting: async (_s: unknown, input: Record<string, unknown>) => (h.sends.push(input), h.sendResult),
  cancelAttendance: async (_s: unknown, scope: Record<string, unknown>) => (h.cancels.push(scope), 'cancelled'),
  // The send's checks (send.test.ts pins them): here, a brief with a goal passes.
  checkSend: async (_s: unknown, input: { brief: { goals?: string[] } }) =>
    input.brief?.goals?.length
      ? { ok: true, checked: { number: '+15555550142', brief: { goals: input.brief.goals, may_share: [], ask: [], must_not_agree: [] } } }
      : { ok: false, reason: 'empty_brief', message: 'Give your assistant at least one goal or one question to ask.' },
}))
vi.mock('@/lib/meeting-agent/store', async (orig) => ({ ...(await orig<typeof import('@/lib/meeting-agent/store')>()), listAttendances: async () => h.rows }))
vi.mock('@/lib/meeting-agent/series', async (orig) => ({
  ...(await orig<typeof import('@/lib/meeting-agent/series')>()),
  listSeries: async () => [{ id: 'ser-1', workspaceId: 'ws-1', userId: 'user-me', seriesId: 'master-1', title: 'Standup', brief: {}, dialInNumber: '+15555550142', dialInPin: 'wwww9#', pausedAt: null }],
  saveSeries: async (_s: unknown, input: Record<string, unknown>) => (h.saved.push(input), { id: 'ser-1', workspaceId: 'ws-1', userId: 'user-me', seriesId: input.seriesId, title: input.title, brief: input.brief, dialInNumber: null, dialInPin: null, pausedAt: null }),
  pauseSeries: async (_s: unknown, scope: unknown, paused: boolean) => (h.paused.push([scope, paused]), true),
  removeSeries: async (_s: unknown, scope: unknown) => (h.removed.push(scope), true),
  seriesRefsOf: async () => new Map([['22222222-2222-4222-8222-222222222222', 'ser-1']]),
}))

import { NextRequest } from 'next/server'
import { DELETE, GET, PATCH, POST } from '../route'
import { attendanceOfRow } from '@/lib/meeting-agent/store'
import { attendanceRow } from '@/lib/meeting-agent/__tests__/fake-db'

const START = '2026-11-30T18:00:00.000Z'
const req = (method: string, body?: unknown, qs = '') => new NextRequest(`https://app.example.com/api/account/meeting-agent${qs}`, { method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) })

beforeEach(() => {
  vi.stubEnv('MEETING_AGENT', 'on')
  h.found = { event: { id: 'evt_1', title: 'Pilot review', start: START, end: '2026-11-30T18:30:00.000Z' }, dialIn: { number: '+15555550142', digits: 'wwwwww1#', platform: 'meet' } }
  h.sends = []
  h.cancels = []
  h.saved = []
  h.paused = []
  h.removed = []
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
  it('lists theirs and their series, never with a PIN', async () => {
    const body = await (await GET()).json()
    expect(body.attendances[0]).toMatchObject({ status: 'scheduled', hasPin: true, displayName: "Sam's assistant (AI)" })
    expect(body.series[0]).toMatchObject({ seriesId: 'master-1', hasPin: true })
    expect(body.attendances[0].seriesRef).toBe('ser-1')
    expect(JSON.stringify(body)).not.toContain('123456789')
    expect(JSON.stringify(body)).not.toContain('wwww9#')
  })

  it("every occurrence: the same checked brief covers the meeting's series; a one-off is refused", async () => {
    h.found = { event: { id: 'evt_1', title: 'Standup', start: START, end: '2026-11-30T18:15:00.000Z', seriesMasterId: 'master-1' }, dialIn: { number: '+15555550142', digits: 'wwwwww1#', platform: 'meet' } }
    const res = await POST(req('POST', { calendar_event_id: 'evt_1', starts_at: START, brief: { goals: ['A yes'] }, every_occurrence: true }))
    expect(res.status).toBe(200)
    expect(h.saved[0]).toMatchObject({ workspaceId: 'ws-1', userId: 'user-me', seriesId: 'master-1', title: 'Standup', dialIn: null })
    expect((await res.json()).series).toMatchObject({ seriesId: 'master-1' })
    h.found = { event: { id: 'evt_1', title: 'One-off', start: START, end: '' }, dialIn: null }
    const oneOff = await POST(req('POST', { calendar_event_id: 'evt_1', starts_at: START, brief: {}, every_occurrence: true }))
    expect(oneOff.status).toBe(400)
    expect(await oneOff.json()).toMatchObject({ code: 'NOT_RECURRING' })
  })

  it('pauses and removes a series by id', async () => {
    const id = '33333333-3333-4333-8333-333333333333'
    expect(await (await PATCH(req('PATCH', { series_id: id, paused: true }))).json()).toEqual({ ok: true })
    expect(h.paused).toEqual([[{ workspaceId: 'ws-1', userId: 'user-me', id }, true]])
    expect((await PATCH(req('PATCH', { series_id: id }))).status).toBe(400)
    expect(await (await DELETE(req('DELETE', undefined, `?series_id=${id}`))).json()).toEqual({ removed: true })
    expect(h.removed).toEqual([{ workspaceId: 'ws-1', userId: 'user-me', id }])
    expect((await DELETE(req('DELETE', undefined, '?series_id=nope'))).status).toBe(400)
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

describe('/api/account/meeting-agent preview (the brief editor)', () => {
  it("runs a send's checks and returns its approval card, writing nothing", async () => {
    h.sendResult = null
    const res = await POST(req('POST', { calendar_event_id: 'evt_1', starts_at: START, brief: { goals: ['A yes'] }, preview: true }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ card: { title: 'Send your assistant to “Pilot review”?', why: expect.stringContaining('Goals: A yes') } })
    expect(h.sends).toEqual([])
  })
  it('a check that fails is the same refusal a send gives', async () => {
    const res = await POST(req('POST', { calendar_event_id: 'evt_1', starts_at: START, brief: { may_share: ['x'] }, preview: true }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'EMPTY_BRIEF' })
  })
})

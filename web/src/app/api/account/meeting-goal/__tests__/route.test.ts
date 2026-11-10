/**
 * /api/account/meeting-goal — the caller's own goal for one meeting
 * (migration 356). Pins: GET/PUT/DELETE fence on the signed-in person and the
 * current workspace; the meeting key is validated (event id, a readable start,
 * normalised); PUT validates the goal (trimmed, 1–500; empty is a 400 because
 * clearing is DELETE), the source, and a capture_id (a UUID; a capture in this
 * workspace, else the goal saves without the link); DELETE takes the
 * meeting from the query or a JSON body. GET ?capture_id (the HUD's goal
 * line) answers the capture's goal and the meeting to write it under: the
 * goal's own, else the capture's event at its start, else (an ad-hoc call)
 * `capture:<id>` at its start; 404 for a capture the caller can't see.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'
import { CAP, EVENT, ME, OTHER, START, WS, goalRow, meetingGoalDb, type MeetingGoalDb } from '@/lib/meetings/__tests__/helpers/meeting-goal-db'

const hoisted = vi.hoisted(() => ({ requireWorkspace: vi.fn() }))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: hoisted.requireWorkspace }))

import { DELETE, GET, PUT } from '@/app/api/account/meeting-goal/route'

let db: MeetingGoalDb
function setup(seed: Parameters<typeof meetingGoalDb>[0] = {}, opts: Parameters<typeof meetingGoalDb>[1] = {}) {
  db = meetingGoalDb(seed, opts)
  hoisted.requireWorkspace.mockResolvedValue({ supabase: db.client, user: { id: ME }, workspaceId: WS })
}

const URL_BASE = 'https://nativeintelligence.dev/api/account/meeting-goal'
const qs = (event = EVENT, start = START) => `?calendar_event_id=${encodeURIComponent(event)}&starts_at=${encodeURIComponent(start)}`
const get = (q = qs()) => GET(buildRequest({ url: `${URL_BASE}${q}`, method: 'GET' }) as unknown as NextRequest)
const put = (body: unknown, raw = false) => PUT(buildRequest({ url: URL_BASE, method: 'PUT', body, raw }) as unknown as NextRequest)
const del = (q = '', body?: unknown) => DELETE(buildRequest({ url: `${URL_BASE}${q}`, method: 'DELETE', body }) as unknown as NextRequest)
const valid = (over: Record<string, unknown> = {}) => ({ calendar_event_id: EVENT, starts_at: START, goal: 'Close the pilot', source: 'prep_card', ...over })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('auth', () => {
  it('passes the auth helper’s response through', async () => {
    hoisted.requireWorkspace.mockResolvedValue(new Response(null, { status: 401 }))
    expect((await get()).status).toBe(401)
    expect((await put(valid())).status).toBe(401)
    expect((await del(qs())).status).toBe(401)
  })
})

describe('GET', () => {
  it("the caller's goal for the meeting (a start in any spelling)", async () => {
    setup({ meeting_goal: [goalRow()] })
    const res = await get(qs(EVENT, '2026-10-17T14:30:00-04:00'))
    expect(res.status).toBe(200)
    const { goal } = await readJson<{ goal: Record<string, unknown> }>(res)
    expect(goal).toMatchObject({ goal: 'Close the pilot', startsAt: START, calendarEventId: EVENT })
  })

  it("null for someone else's goal", async () => {
    setup({ meeting_goal: [goalRow({ user_id: OTHER })] })
    expect(await readJson(await get())).toEqual({ goal: null })
  })

  it.each([
    ['no event id', `?starts_at=${START}`],
    ['no start', `?calendar_event_id=${EVENT}`],
    ['an unreadable start', qs(EVENT, 'soon')],
  ])('%s: 400', async (_label, q) => {
    setup()
    expect((await get(q)).status).toBe(400)
  })

  it('a failed read: 500', async () => {
    setup({}, { failOn: 'select' })
    expect((await get()).status).toBe(500)
  })
})

describe('GET ?capture_id (the HUD’s goal line)', () => {
  const byCapture = (id = CAP) => get(`?capture_id=${encodeURIComponent(id)}`)
  const ADHOC = { id: CAP, workspace_id: WS, user_id: ME, visibility: 'private', calendar_event_id: null, occurrence_start: null, scheduled_start: null, started_at: '2026-10-18T15:00:00+00:00', created_at: '2026-10-18T14:59:00+00:00' }

  it("an ad-hoc call with no goal: the capture's own synthetic meeting at its start", async () => {
    setup({ captures: [ADHOC] })
    const res = await byCapture()
    expect(res.status).toBe(200)
    expect(await readJson(res)).toEqual({ goal: null, meeting: { calendarEventId: `capture:${CAP}`, startsAt: '2026-10-18T15:00:00.000Z' } })
  })

  it("a calendar call with no goal: its event at the occurrence's start", async () => {
    setup({ captures: [{ ...ADHOC, visibility: 'workspace', user_id: OTHER, calendar_event_id: EVENT, occurrence_start: '2026-10-17T14:30:00-04:00' }] })
    expect(await readJson(await byCapture())).toEqual({ goal: null, meeting: { calendarEventId: EVENT, startsAt: START } })
  })

  it("with a goal: the goal's own meeting, so an edit replaces it", async () => {
    setup({ meeting_goal: [goalRow({ capture_id: CAP, calendar_event_id: 'evt-other', starts_at: '2026-10-17T19:00:00Z' })], captures: [{ ...ADHOC, calendar_event_id: EVENT, occurrence_start: START }] })
    const body = await readJson<{ goal: Record<string, unknown>; meeting: unknown }>(await byCapture())
    expect(body.goal).toMatchObject({ goal: 'Close the pilot' })
    expect(body.meeting).toEqual({ calendarEventId: 'evt-other', startsAt: '2026-10-17T19:00:00.000Z' })
  })

  it("a goal saved there with the HUD's PUT is the one the capture finds next", async () => {
    setup({ captures: [ADHOC] })
    const { meeting } = await readJson<{ meeting: { calendarEventId: string; startsAt: string } }>(await byCapture())
    expect((await put({ calendar_event_id: meeting.calendarEventId, starts_at: meeting.startsAt, capture_id: CAP, goal: 'Agree the rollout', source: 'hud' })).status).toBe(200)
    expect(db.tables.meeting_goal[0]).toMatchObject({ calendar_event_id: `capture:${CAP}`, capture_id: CAP, source: 'hud', user_id: ME })
    const again = await readJson<{ goal: Record<string, unknown>; meeting: unknown }>(await byCapture())
    expect(again.goal).toMatchObject({ goal: 'Agree the rollout', source: 'hud' })
    expect(again.meeting).toEqual(meeting)
  })

  it('404 for a capture not in this workspace or another person’s private one; 400 for a non-UUID', async () => {
    setup({ captures: [{ ...ADHOC, workspace_id: 'ws-2' }] })
    expect((await byCapture()).status).toBe(404)
    setup({ captures: [{ ...ADHOC, user_id: OTHER }] })
    expect((await byCapture()).status).toBe(404)
    setup({ captures: [ADHOC] })
    expect((await byCapture('../x')).status).toBe(400)
  })
})

describe('PUT', () => {
  it('saves the goal as the caller’s, trimmed, with the capture', async () => {
    setup({ captures: [{ id: CAP, workspace_id: WS }] })
    const res = await put(valid({ goal: '  Close the pilot  ', capture_id: CAP }))
    expect(res.status).toBe(200)
    expect((await readJson<{ goal: Record<string, unknown> }>(res)).goal).toMatchObject({ goal: 'Close the pilot', captureId: CAP })
    expect(db.tables.meeting_goal).toHaveLength(1)
    expect(db.tables.meeting_goal[0]).toMatchObject({ workspace_id: WS, user_id: ME, source: 'prep_card', capture_id: CAP })
  })

  it('a second save replaces the first', async () => {
    setup()
    await put(valid())
    await put(valid({ goal: 'Get a yes', source: 'chat' }))
    expect(db.tables.meeting_goal).toHaveLength(1)
    expect(db.tables.meeting_goal[0]).toMatchObject({ goal: 'Get a yes', source: 'chat' })
  })

  it.each([
    ['no goal', { goal: undefined }],
    ['an empty goal (DELETE clears)', { goal: '   ' }],
    ['a goal over 500 characters', { goal: 'x'.repeat(501) }],
    ['an unknown source', { source: 'email' }],
    ['no event id', { calendar_event_id: '' }],
    ['an unreadable start', { starts_at: 'tomorrow-ish' }],
    ['a capture_id that is not a UUID', { capture_id: '../x' }],
  ])('%s: 400, nothing written', async (_label, over) => {
    setup()
    expect((await put(valid(over))).status).toBe(400)
    expect(db.tables.meeting_goal).toHaveLength(0)
  })

  it.each([
    ['in another workspace', [{ id: CAP, workspace_id: 'ws-2' }]],
    ['deleted', []],
  ])('a capture %s: the goal saves without the link', async (_label, captures) => {
    setup({ captures })
    const res = await put(valid({ capture_id: CAP }))
    expect(res.status).toBe(200)
    expect((await readJson<{ goal: Record<string, unknown> }>(res)).goal).toMatchObject({ goal: 'Close the pilot', captureId: null })
    expect(db.tables.meeting_goal).toHaveLength(1)
    expect(db.tables.meeting_goal[0].capture_id).toBeNull()
  })

  it('exactly 500 characters is fine', async () => {
    setup()
    expect((await put(valid({ goal: 'x'.repeat(500) }))).status).toBe(200)
  })

  it('invalid JSON: 400', async () => {
    setup()
    expect((await put('{nope', true)).status).toBe(400)
  })

  it('a failed write: 500', async () => {
    setup({}, { failOn: 'upsert' })
    expect((await put(valid())).status).toBe(500)
  })
})

describe('DELETE', () => {
  it("clears the caller's goal, from the query", async () => {
    setup({ meeting_goal: [goalRow({ id: 'mine' }), goalRow({ id: 'theirs', user_id: OTHER })] })
    const res = await del(qs())
    expect(await readJson(res)).toEqual({ cleared: true })
    expect(db.tables.meeting_goal.map((r) => r.id)).toEqual(['theirs'])
  })

  it('or from a JSON body', async () => {
    setup({ meeting_goal: [goalRow()] })
    expect(await readJson(await del('', { calendar_event_id: EVENT, starts_at: START }))).toEqual({ cleared: true })
  })

  it('nothing to clear: cleared false', async () => {
    setup()
    expect(await readJson(await del(qs()))).toEqual({ cleared: false })
  })

  it('no meeting: 400', async () => {
    setup()
    expect((await del()).status).toBe(400)
  })
})
